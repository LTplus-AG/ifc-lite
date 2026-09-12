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
/// `IfcMapConversion` X-axis abscissa/ordinate) into a KML `<Model><Orientation><heading>`,
/// a clockwise **rotation** of a model whose local X-axis starts pointing east. Returns `0`
/// when either component is absent. KML heading is not a compass bearing: at `heading = 0`
/// the X-axis already points east (KML's baseline), and rotating clockwise by `heading` moves
/// it to true bearing `90 + heading`, so reaching bearing `B` takes `B - 90` (mod 360).
pub fn ifc_angle_to_kml_heading(x_abscissa: Option<f64>, x_ordinate: Option<f64>) -> f64 {
    match (x_abscissa, x_ordinate) {
        // A zero-length axis is degenerate (atan2(0,0) = 0 would otherwise map to a
        // spurious rotation); treat it like a missing axis → no rotation.
        (Some(x), Some(y)) if x == 0.0 && y == 0.0 => 0.0,
        (Some(x), Some(y)) => {
            let angle_from_east_ccw = y.atan2(x).to_degrees();
            // bearing = 90 - angle (CCW-from-east → CW-from-north); heading = bearing - 90
            // = -angle, normalized to [0, 360). `+ 0.0` folds a resulting -0.0 (e.g. when
            // angle is exactly 0) back to +0.0 so it doesn't render as "<heading>-0</heading>".
            (-angle_from_east_ccw).rem_euclid(360.0) + 0.0
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
/// "Unsupported element: Model"); prefer [`try_export_kmz_collada_from_meshes`], which
/// embeds a COLLADA `.dae` — the format Google Earth actually renders (#1427).
///
/// Superseded by its own account and infallible (an empty GLB packs as
/// success), which is the class the `try_` twins close. It stays reachable
/// through the wasm `exportKmz` binding and the geometry bridge.
// TODO(remove-by: #4591 lands the wasm/bridge/index.ts removal under the
// pending Rust major, louistrue): delete with `pack_kmz` inlined.
pub fn export_kmz(glb: &[u8], opts: &KmzOptions) -> Vec<u8> {
    pack_kmz(glb, "model.glb", opts)
}

/// Build a Google-Earth-ready KMZ (`doc.kml` + `model.dae`) directly from the
/// viewer's already-produced (Y-up) meshes, the working path (#1427). The model
/// is embedded as **COLLADA** (the only `<Model>` format Google Earth loads), with
/// emission-lit, double-sided materials and `clampToGround` placement. Mesh arrays
/// match [`crate::try_export_collada_from_meshes`] / `export_glb_from_meshes`.
///
/// Fails closed when the embedded COLLADA would carry no geometry: the archive
/// this used to ship around a schema-invalid document was read as success by
/// every caller. See [`crate::try_export_collada_from_meshes`] for the two
/// inputs that reach that state.
#[allow(clippy::too_many_arguments)]
pub fn try_export_kmz_collada_from_meshes(
    positions: &[f32],
    normals: &[f32],
    indices: &[u32],
    vertex_counts: &[u32],
    index_counts: &[u32],
    colors: &[f32],
    origins: &[f64],
    opts: &KmzOptions,
) -> Result<Vec<u8>, crate::error::ExportError> {
    let dae = crate::try_export_collada_from_meshes(
        positions,
        normals,
        indices,
        vertex_counts,
        index_counts,
        colors,
        origins,
    )?;
    Ok(pack_kmz(&dae, "model.dae", opts))
}

/// `doc.kml` plus one model file in a stored ZIP: the one archive layout both
/// KMZ entry points produce, so placement and layout cannot drift between them.
fn pack_kmz(model: &[u8], href: &str, opts: &KmzOptions) -> Vec<u8> {
    let heading = ifc_angle_to_kml_heading(opts.x_axis_abscissa, opts.x_axis_ordinate);
    let kml = build_kml(opts, heading, href);

    let mut zip = StoredZip::new();
    zip.add("doc.kml", kml.as_bytes());
    zip.add(href, model);
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
#[path = "kmz_tests.rs"]
mod tests;
