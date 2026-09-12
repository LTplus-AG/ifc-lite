// SPDX-License-Identifier: MPL-2.0
//! Tests for [`super::kmz`]. Split out of `kmz.rs` under the house pattern
//! (AGENTS.md: a sibling `<name>_tests.rs` wired with `#[cfg(test)] #[path]`),
//! so the module stays under the 400-line rule.

use super::*;

#[test]
fn heading_matches_ifc_convention() {
    // No axes → 0.
    assert_eq!(ifc_angle_to_kml_heading(None, None), 0.0);
    // Degenerate zero-length axis → 0 (not 90 from atan2(0,0)).
    assert_eq!(ifc_angle_to_kml_heading(Some(0.0), Some(0.0)), 0.0);
    // X-axis along east (1,0): bearing 90, heading = bearing - 90 = 0.
    assert!((ifc_angle_to_kml_heading(Some(1.0), Some(0.0)) - 0.0).abs() < 1e-9);
    // X-axis along north (0,1): bearing 0, heading = 0 - 90 = -90 → 270.
    assert!((ifc_angle_to_kml_heading(Some(0.0), Some(1.0)) - 270.0).abs() < 1e-9);
    // X-axis along west (-1,0): bearing 270, heading = 270 - 90 = 180.
    assert!((ifc_angle_to_kml_heading(Some(-1.0), Some(0.0)) - 180.0).abs() < 1e-9);
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
    assert!(kml.contains("<heading>0</heading>"));
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
    let kmz = try_export_kmz_collada_from_meshes(
        &positions,
        &normals,
        &[0, 1, 2],
        &[3],
        &[3],
        &[1.0, 0.0, 0.0, 1.0],
        &[0.0, 0.0, 0.0],
        &opts,
    )
    .expect("a triangle is render geometry");
    // Stored ZIP holding doc.kml + model.dae, KML referencing the .dae.
    assert!(kmz.windows(7).any(|w| w == b"doc.kml"));
    assert!(kmz.windows(9).any(|w| w == b"model.dae"), "embeds model.dae");
    assert!(
        kmz.windows(8).any(|w| w == b"COLLADA "),
        "the .dae is COLLADA, not glTF"
    );
}

/// The refusal (pinned on `try_export_collada_from_meshes`) propagates through
/// the archive wrapper; the old `Vec<u8>` path had no error channel.
#[test]
fn kmz_from_an_empty_mesh_set_fails_closed_instead_of_shipping_an_empty_model() {
    let opts = KmzOptions { name: Some("IFC Model".into()), ..Default::default() };
    let err = try_export_kmz_collada_from_meshes(&[], &[], &[], &[], &[], &[], &[], &opts)
        .expect_err("an empty mesh set must be NoRenderGeometry");
    assert!(matches!(err, crate::ExportError::NoRenderGeometry), "got {err:?}");
}
