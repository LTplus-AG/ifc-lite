// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Georeferencing TRANSFORMATION math — not just extraction.
//!
//! `issue_900_georeferencing_metadata.rs` already pins that the
//! `IfcMapConversion` parameters are *extracted* and surfaced on
//! `ModelMetadata`. This test pins the *math*: a known local point must map
//! to a hand-computed world coordinate through the fixture's real map
//! conversion, both via `GeoReference::local_to_map` and via the column-major
//! `transform_matrix` that `extract_georeferencing` derives — and the inverse
//! (`map_to_local`) must round-trip back.

use ifc_lite_core::GeoReference;
use ifc_lite_processing::extract_georeferencing;

/// Real-world fixture (buildingSMART georeferencing sample, UTM zone 10N):
///
/// ```text
/// #38=IFCMAPCONVERSION(#10,#37,545991.679663973,4184941.96970872,0.,
///                      -0.0977396728779572,0.995212015776392,0.9996);
/// ```
///
/// Attribute order: SourceCRS, TargetCRS, Eastings, Northings,
/// OrthogonalHeight, XAxisAbscissa (cos), XAxisOrdinate (sin), Scale.
const FIXTURE: &str = "../../tests/models/ifc5/Georeferencing_georeferenced-bridge-deck.ifc";

// Parameters read directly out of #38 in the fixture file.
const EASTINGS: f64 = 545991.679663973;
const NORTHINGS: f64 = 4184941.96970872;
const ORTHO_HEIGHT: f64 = 0.0;
const X_AXIS_ABSCISSA: f64 = -0.0977396728779572; // cos(rotation)
const X_AXIS_ORDINATE: f64 = 0.995212015776392; // sin(rotation)
const SCALE: f64 = 0.9996;

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping georef map-conversion math test: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

#[test]
fn map_conversion_transforms_local_point_to_expected_world_coordinate() {
    let Some(content) = read_fixture() else {
        return;
    };

    let geo = extract_georeferencing(content.as_bytes())
        .expect("bridge-deck fixture must yield georeferencing (IfcMapConversion #38)");

    // Extraction sanity (already covered elsewhere, kept tight here so the
    // math below is anchored to the fixture, not to stale constants).
    assert!((geo.eastings - EASTINGS).abs() < 1e-6);
    assert!((geo.northings - NORTHINGS).abs() < 1e-6);
    assert!((geo.orthogonal_height - ORTHO_HEIGHT).abs() < 1e-9);
    assert!((geo.x_axis_abscissa - X_AXIS_ABSCISSA).abs() < 1e-12);
    assert!((geo.x_axis_ordinate - X_AXIS_ORDINATE).abs() < 1e-12);
    assert!((geo.scale - SCALE).abs() < 1e-12);
    // The X-axis direction must be (near) unit length for cos/sin semantics.
    let norm =
        geo.x_axis_abscissa * geo.x_axis_abscissa + geo.x_axis_ordinate * geo.x_axis_ordinate;
    assert!(
        (norm - 1.0).abs() < 1e-9,
        "X-axis direction not unit length: {norm}"
    );

    // Local→map per IFC4x3 IfcMapConversion ("a scaling of the three axes
    // (x,y,z), by the same Scale, followed by an anti-clockwise rotation
    // about the z-axis [...] then a translation in (x,y,z) of Eastings,
    // Northings, OrthogonalHeight" — and explicitly: "one scale is applied
    // equally to x, y and z, to convert units"):
    //                    E = S·(cosθ·x − sinθ·y) + Eastings
    //                    N = S·(sinθ·x + cosθ·y) + Northings
    //                    H = S·z + OrthogonalHeight
    //
    // Hand arithmetic for local point (100, 50, 5):
    //   cosθ·x = −0.0977396728779572 · 100 = −9.77396728779572
    //   sinθ·y =  0.995212015776392 ·  50 = 49.760600788819595
    //   rotX   = −9.77396728779572 − 49.760600788819595 = −59.534568076615315
    //   S·rotX = 0.9996 · −59.534568076615315          = −59.510754249384675
    //   E      = 545991.679663973 − 59.510754249384675 = 545932.168909724
    //
    //   sinθ·x =  0.995212015776392 · 100 = 99.52120157763919
    //   cosθ·y = −0.0977396728779572 · 50 = −4.88698364389786
    //   rotY   = 99.52120157763919 − 4.88698364389786  = 94.63421793374133
    //   S·rotY = 0.9996 · 94.63421793374133            = 94.59636424656783
    //   N      = 4184941.96970872 + 94.59636424656783  = 4185036.566072967
    //
    //   H      = 0.9996 · 5 + 0 = 4.998
    const LOCAL: (f64, f64, f64) = (100.0, 50.0, 5.0);
    const EXPECTED_E: f64 = 545932.168909724;
    const EXPECTED_N: f64 = 4185036.566072967;
    const EXPECTED_H: f64 = 4.998;

    // 1) Through the production transform function.
    let core_geo = GeoReference {
        eastings: geo.eastings,
        northings: geo.northings,
        orthogonal_height: geo.orthogonal_height,
        x_axis_abscissa: geo.x_axis_abscissa,
        x_axis_ordinate: geo.x_axis_ordinate,
        scale: geo.scale,
        ..GeoReference::new()
    };
    let (e, n, h) = core_geo.local_to_map(LOCAL.0, LOCAL.1, LOCAL.2);
    assert!(
        (e - EXPECTED_E).abs() < 1e-6,
        "eastings: got {e}, expected {EXPECTED_E}"
    );
    assert!(
        (n - EXPECTED_N).abs() < 1e-6,
        "northings: got {n}, expected {EXPECTED_N}"
    );
    assert!(
        (h - EXPECTED_H).abs() < 1e-9,
        "height: got {h}, expected {EXPECTED_H}"
    );

    // 2) Through the derived column-major 4×4 transform_matrix — the form
    //    consumers (viewer/server metadata) actually receive. Column-major:
    //    out_i = m[i]·x + m[4+i]·y + m[8+i]·z + m[12+i].
    let m = &geo.transform_matrix;
    let me = m[0] * LOCAL.0 + m[4] * LOCAL.1 + m[8] * LOCAL.2 + m[12];
    let mn = m[1] * LOCAL.0 + m[5] * LOCAL.1 + m[9] * LOCAL.2 + m[13];
    let mh = m[2] * LOCAL.0 + m[6] * LOCAL.1 + m[10] * LOCAL.2 + m[14];
    assert!((me - EXPECTED_E).abs() < 1e-6, "matrix eastings: got {me}");
    assert!((mn - EXPECTED_N).abs() < 1e-6, "matrix northings: got {mn}");
    assert!((mh - EXPECTED_H).abs() < 1e-9, "matrix height: got {mh}");

    // 3) Inverse must round-trip: map_to_local(local_to_map(p)) == p.
    let (rx, ry, rz) = core_geo.map_to_local(e, n, h);
    assert!((rx - LOCAL.0).abs() < 1e-6, "round-trip x: got {rx}");
    assert!((ry - LOCAL.1).abs() < 1e-6, "round-trip y: got {ry}");
    assert!((rz - LOCAL.2).abs() < 1e-9, "round-trip z: got {rz}");

    // 4) Derived rotation: atan2(sin, cos) = atan2(0.995212…, −0.097740…)
    //    ≈ 95.6090255829533° (grid north is rotated ~95.6° from local +X).
    assert!(
        (geo.rotation_degrees - 95.6090255829533).abs() < 1e-9,
        "rotation_degrees: got {}",
        geo.rotation_degrees
    );
}
