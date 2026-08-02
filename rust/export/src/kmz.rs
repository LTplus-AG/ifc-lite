// SPDX-License-Identifier: MPL-2.0
//! **KMZ** (Google Earth) exporter — a ZIP archive of `doc.kml` + `model.glb` so
//! Google Earth can place a georeferenced 3D model at its real-world lat/lon/altitude.
//!
//! Ports `apps/viewer/src/lib/geo/kmz-exporter.ts`. The GLB is produced upstream by
//! the Rust GLB exporter; this module computes the KML placement (incl. the IFC
//! grid-north → KML heading conversion) and packs the archive.
//!
//! The archive uses the ZIP **stored** (uncompressed) method, written by hand so the
//! default/wasm build pulls in no zip/deflate dependency (keeping the wasm bundle
//! lean). KMZ readers accept stored entries; the trade-off is a larger file than a
//! deflated archive, acceptable for this infrequent georef export.

/// KML `<altitudeMode>` — how Google Earth interprets the model's `altitude`.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum AltitudeMode {
    /// IGNORE `altitude`; rest the model origin on the terrain, following the
    /// ground. The robust default for a building that should sit on the ground:
    /// it can never float and is immune to a wrong / zero / double-counted
    /// `IfcMapConversion.OrthogonalHeight` (#1427). KML's own default mode.
    #[default]
    ClampToGround,
    /// `altitude` is metres ABOVE the terrain directly below the origin.
    RelativeToGround,
    /// `altitude` is metres above mean sea level, independent of terrain.
    Absolute,
}

impl AltitudeMode {
    fn as_kml(self) -> &'static str {
        match self {
            AltitudeMode::ClampToGround => "clampToGround",
            AltitudeMode::RelativeToGround => "relativeToGround",
            AltitudeMode::Absolute => "absolute",
        }
    }
}

/// Options for KMZ export.
///
/// Derives `Default` (matching peer `*Options` structs) so callers can spread
/// `..Default::default()` and stay source-compatible as fields are added.
#[derive(Default)]
pub struct KmzOptions {
    /// WGS84 latitude of the model origin (degrees).
    pub latitude: f64,
    /// WGS84 longitude of the model origin (degrees).
    pub longitude: f64,
    /// Orthogonal height / elevation in metres. Ignored by Google Earth when
    /// `altitude_mode` is `ClampToGround` (the default).
    pub altitude: f64,
    /// How Google Earth places the model vertically. Defaults to `ClampToGround`
    /// so the model rests on the terrain instead of floating at its MSL elevation
    /// (the `relativeToGround` + OrthogonalHeight bug — #1427).
    pub altitude_mode: AltitudeMode,
    /// `IfcMapConversion` `XAxisAbscissa` (grid-north X component). When either axis
    /// component is absent the heading is `0` (local north == true north).
    pub x_axis_abscissa: Option<f64>,
    /// `IfcMapConversion` `XAxisOrdinate` (grid-north Y component).
    pub x_axis_ordinate: Option<f64>,
    /// Placemark display name (defaults to `IFC Model`).
    pub name: Option<String>,
}

/// Convert the IFC angle-to-grid-north (counter-clockwise from map east, via the
/// `IfcMapConversion` X-axis abscissa/ordinate) into a KML heading (clockwise from
/// north: 0 = N, 90 = E, 180 = S, 270 = W). Returns `0` when either component is absent.
pub fn ifc_angle_to_kml_heading(x_abscissa: Option<f64>, x_ordinate: Option<f64>) -> f64 {
    match (x_abscissa, x_ordinate) {
        // A zero-length axis is degenerate (atan2(0,0) = 0 would otherwise map to 90);
        // treat it like a missing axis → no rotation.
        (Some(x), Some(y)) if x == 0.0 && y == 0.0 => 0.0,
        (Some(x), Some(y)) => {
            let angle_from_east_ccw = y.atan2(x).to_degrees();
            // heading = 90 - angle (CCW-from-east → CW-from-north), normalized to [0, 360).
            (90.0 - angle_from_east_ccw).rem_euclid(360.0)
        }
        _ => 0.0,
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn build_kml(opts: &KmzOptions, heading: f64, model_href: &str) -> String {
    let name = xml_escape(opts.name.as_deref().unwrap_or("IFC Model"));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>{name}</name>
    <Placemark>
      <name>{name}</name>
      <Model id="model">
        <altitudeMode>{altitude_mode}</altitudeMode>
        <Location>
          <longitude>{lon}</longitude>
          <latitude>{lat}</latitude>
          <altitude>{alt}</altitude>
        </Location>
        <Orientation>
          <heading>{heading}</heading>
          <tilt>0</tilt>
          <roll>0</roll>
        </Orientation>
        <Scale>
          <x>1</x>
          <y>1</y>
          <z>1</z>
        </Scale>
        <Link>
          <href>{href}</href>
        </Link>
      </Model>
    </Placemark>
  </Document>
</kml>"#,
        name = name,
        altitude_mode = opts.altitude_mode.as_kml(),
        lon = opts.longitude,
        lat = opts.latitude,
        alt = opts.altitude,
        heading = heading,
        href = model_href,
    )
}

/// Build a KMZ archive (`doc.kml` + `model.glb`) from a GLB byte slice + placement.
///
/// Note: Google Earth's KML `<Model>` does NOT load glTF/GLB (it raises
/// "Unsupported element: Model"); prefer [`export_kmz_collada_from_meshes`], which
/// embeds a COLLADA `.dae` — the format Google Earth actually renders (#1427).
pub fn export_kmz(glb: &[u8], opts: &KmzOptions) -> Vec<u8> {
    let heading = ifc_angle_to_kml_heading(opts.x_axis_abscissa, opts.x_axis_ordinate);
    let kml = build_kml(opts, heading, "model.glb");

    let mut zip = StoredZip::new();
    zip.add("doc.kml", kml.as_bytes());
    zip.add("model.glb", glb);
    zip.finish()
}

/// Build a Google-Earth-ready KMZ (`doc.kml` + `model.dae`) directly from the
/// viewer's already-produced (Y-up) meshes — the working path (#1427). The model
/// is embedded as **COLLADA** (the only `<Model>` format Google Earth loads), with
/// emission-lit, double-sided materials and `clampToGround` placement. Mesh arrays
/// match [`crate::export_collada_from_meshes`] / `export_glb_from_meshes`.
#[allow(clippy::too_many_arguments)]
pub fn export_kmz_collada_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
    opts: &KmzOptions,
) -> Vec<u8> {
    let dae = crate::export_collada_from_meshes(
        positions,
        normals,
        indices,
        vertex_counts,
        index_counts,
        colors,
        origins,
    );
    let heading = ifc_angle_to_kml_heading(opts.x_axis_abscissa, opts.x_axis_ordinate);
    let kml = build_kml(opts, heading, "model.dae");

    let mut zip = StoredZip::new();
    zip.add("doc.kml", kml.as_bytes());
    zip.add("model.dae", &dae);
    zip.finish()
}

// ── Minimal stored-ZIP writer ──────────────────────────────────────────────────

/// A bare-bones ZIP writer that stores entries uncompressed (method 0). Enough for
/// KMZ; avoids a zip/deflate crate dependency in the default/wasm build.
struct StoredZip {
    out: Vec<u8>,
    central: Vec<u8>,
    count: u16,
}

// Fixed DOS timestamp (1980-01-01 00:00:00) so archives are byte-deterministic
// (and because wall-clock time is unavailable on wasm).
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 0x0021;

impl StoredZip {
    fn new() -> Self {
        StoredZip { out: Vec::new(), central: Vec::new(), count: 0 }
    }

    fn add(&mut self, name: &str, data: &[u8]) {
        let crc = crc32(data);
        let offset = self.out.len() as u32;
        let name_bytes = name.as_bytes();
        let size = data.len() as u32;

        // Local file header.
        self.out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        self.out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        self.out.extend_from_slice(&0u16.to_le_bytes()); // flags
        self.out.extend_from_slice(&0u16.to_le_bytes()); // method = stored
        self.out.extend_from_slice(&DOS_TIME.to_le_bytes());
        self.out.extend_from_slice(&DOS_DATE.to_le_bytes());
        self.out.extend_from_slice(&crc.to_le_bytes());
        self.out.extend_from_slice(&size.to_le_bytes()); // compressed size
        self.out.extend_from_slice(&size.to_le_bytes()); // uncompressed size
        self.out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // extra length
        self.out.extend_from_slice(name_bytes);
        self.out.extend_from_slice(data);

        // Central directory record.
        self.central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        self.central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        self.central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        self.central.extend_from_slice(&0u16.to_le_bytes()); // flags
        self.central.extend_from_slice(&0u16.to_le_bytes()); // method
        self.central.extend_from_slice(&DOS_TIME.to_le_bytes());
        self.central.extend_from_slice(&DOS_DATE.to_le_bytes());
        self.central.extend_from_slice(&crc.to_le_bytes());
        self.central.extend_from_slice(&size.to_le_bytes());
        self.central.extend_from_slice(&size.to_le_bytes());
        self.central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        self.central.extend_from_slice(&0u16.to_le_bytes()); // extra length
        self.central.extend_from_slice(&0u16.to_le_bytes()); // comment length
        self.central.extend_from_slice(&0u16.to_le_bytes()); // disk number start
        self.central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        self.central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        self.central.extend_from_slice(&offset.to_le_bytes());
        self.central.extend_from_slice(name_bytes);

        self.count += 1;
    }

    fn finish(mut self) -> Vec<u8> {
        let cd_offset = self.out.len() as u32;
        let cd_size = self.central.len() as u32;
        self.out.extend_from_slice(&self.central);

        // End of central directory record.
        self.out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // disk number
        self.out.extend_from_slice(&0u16.to_le_bytes()); // cd start disk
        self.out.extend_from_slice(&self.count.to_le_bytes()); // entries this disk
        self.out.extend_from_slice(&self.count.to_le_bytes()); // total entries
        self.out.extend_from_slice(&cd_size.to_le_bytes());
        self.out.extend_from_slice(&cd_offset.to_le_bytes());
        self.out.extend_from_slice(&0u16.to_le_bytes()); // comment length
        self.out
    }
}

/// CRC-32 (IEEE 802.3, polynomial 0xEDB88320) — the checksum ZIP entries require.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= byte as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_matches_ifc_convention() {
        // No axes → 0.
        assert_eq!(ifc_angle_to_kml_heading(None, None), 0.0);
        // Degenerate zero-length axis → 0 (not 90 from atan2(0,0)).
        assert_eq!(ifc_angle_to_kml_heading(Some(0.0), Some(0.0)), 0.0);
        // X-axis along east (1,0): angle-from-east 0 → heading 90.
        assert!((ifc_angle_to_kml_heading(Some(1.0), Some(0.0)) - 90.0).abs() < 1e-9);
        // X-axis along north (0,1): angle-from-east 90 CCW → heading 0.
        assert!((ifc_angle_to_kml_heading(Some(0.0), Some(1.0)) - 0.0).abs() < 1e-9);
        // X-axis along west (-1,0): angle 180 → heading 90-180 = -90 → 270.
        assert!((ifc_angle_to_kml_heading(Some(-1.0), Some(0.0)) - 270.0).abs() < 1e-9);
    }

    #[test]
    fn kml_carries_placement() {
        let opts = KmzOptions {
            latitude: 47.5,
            longitude: 8.5,
            altitude: 412.0,
            altitude_mode: AltitudeMode::Absolute,
            x_axis_abscissa: Some(1.0),
            x_axis_ordinate: Some(0.0),
            name: Some("Bldg <A>".to_string()),
        };
        let kml = build_kml(&opts, ifc_angle_to_kml_heading(opts.x_axis_abscissa, opts.x_axis_ordinate), "model.dae");
        assert!(kml.contains("<latitude>47.5</latitude>"));
        assert!(kml.contains("<longitude>8.5</longitude>"));
        assert!(kml.contains("<altitude>412</altitude>"));
        assert!(kml.contains("<altitudeMode>absolute</altitudeMode>"));
        assert!(kml.contains("<heading>90</heading>"));
        assert!(kml.contains("<href>model.dae</href>"));
        assert!(kml.contains("Bldg &lt;A&gt;"), "name is XML-escaped");
    }

    #[test]
    fn default_altitude_mode_clamps_to_ground() {
        // #1427: the default must rest the model on the terrain, not float it at its
        // MSL OrthogonalHeight (the relativeToGround bug).
        let opts = KmzOptions {
            latitude: 47.5,
            longitude: 8.5,
            altitude: 560.0,
            altitude_mode: AltitudeMode::default(),
            x_axis_abscissa: None,
            x_axis_ordinate: None,
            name: None,
        };
        let kml = build_kml(&opts, 0.0, "model.dae");
        assert!(kml.contains("<altitudeMode>clampToGround</altitudeMode>"));
        assert!(
            !kml.contains("relativeToGround"),
            "must not re-introduce the floating relativeToGround placement"
        );
    }

    #[test]
    fn kmz_is_a_valid_stored_zip() {
        let glb = b"glTF\x02\x00\x00\x00placeholder-binary";
        let opts = KmzOptions {
            latitude: 0.0,
            longitude: 0.0,
            altitude: 0.0,
            altitude_mode: AltitudeMode::default(),
            x_axis_abscissa: None,
            x_axis_ordinate: None,
            name: None,
        };
        let kmz = export_kmz(glb, &opts);

        // Starts with a local file header, ends with the EOCD signature.
        assert_eq!(&kmz[0..4], &0x0403_4b50u32.to_le_bytes());
        let eocd = &0x0605_4b50u32.to_le_bytes();
        assert!(kmz.windows(4).any(|w| w == eocd), "has end-of-central-directory");

        // Both entry names + the GLB bytes are present (stored, uncompressed).
        assert!(kmz.windows(7).any(|w| w == b"doc.kml"));
        assert!(kmz.windows(9).any(|w| w == b"model.glb"));
        assert!(kmz.windows(glb.len()).any(|w| w == glb), "GLB stored verbatim");
    }

    #[test]
    fn collada_kmz_embeds_dae_and_references_it() {
        // #1427: the working path embeds a COLLADA model (model.dae) — the format
        // Google Earth's <Model> actually loads — not a glTF GLB.
        let positions = vec![0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0];
        let normals: Vec<f32> = std::iter::repeat_n([0.0f32, 1.0, 0.0], 3).flatten().collect();
        let opts = KmzOptions {
            latitude: 52.15,
            longitude: 5.38,
            altitude: 560.0,
            altitude_mode: AltitudeMode::default(),
            x_axis_abscissa: None,
            x_axis_ordinate: None,
            name: Some("IFC Model".into()),
        };
        let kmz = export_kmz_collada_from_meshes(
            &positions,
            &normals,
            &[0, 1, 2],
            &[3],
            &[3],
            &[1.0, 0.0, 0.0, 1.0],
            &[0.0, 0.0, 0.0],
            &opts,
        );
        // Stored ZIP holding doc.kml + model.dae, KML referencing the .dae.
        assert!(kmz.windows(7).any(|w| w == b"doc.kml"));
        assert!(kmz.windows(9).any(|w| w == b"model.dae"), "embeds model.dae");
        assert!(
            kmz.windows(8).any(|w| w == b"COLLADA "),
            "the .dae is COLLADA, not glTF"
        );
    }
}
