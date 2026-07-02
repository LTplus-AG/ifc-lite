// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Golden tests for the site-local coordinate-space tier: the three-tier
//! selection in `processor/mod.rs` plus the inverse rotation applied by
//! `processor/site_local.rs::convert_mesh_to_site_local`.
//!
//! The identity path is already covered by `geometry_data_export_test.rs`;
//! this pins the previously untested NON-identity rotation path: an IfcSite
//! placed with a 30 degree yaw about Z and a non-zero translation must yield
//! meshes expressed in the site-local frame (positions and normals inverse
//! rotated, the site translation carried as the RTC offset), with unit-length
//! normals. Uses INLINE minimal IFC (one 4 x 1 x 2 extruded box placed
//! relative to the site) so the test runs in CI without external fixtures.

use ifc_lite_processing::{process_geometry, MeshData, ProcessingResult};

/// Box dimensions in the element's local frame (metres).
const BOX: [f64; 3] = [4.0, 1.0, 2.0];
/// Site placement translation for the non-identity fixtures (metres).
const SITE_T: [f64; 3] = [10.0, 20.0, 0.0];
/// f32 mesh positions folded back to f64: ~1 ulp at coordinate magnitude 4.
const EPS: f64 = 1e-5;

/// Minimal IFC4 model: one IfcBuildingElementProxy, a 4 x 1 x 2 box extruded
/// from the origin, placed RELATIVE to the IfcSite placement (#34), metre
/// units. `site_placement` supplies the #30..#33 placement entities so each
/// test can vary the site location/rotation without duplicating the body.
fn model(site_placement: &str) -> String {
    format!(
        r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
{site_placement}
#34=IFCLOCALPLACEMENT($,#33);
#35=IFCSITE('1s1tEAnIV5BixApwp1Yzp0',$,'site',$,$,#34,$,$,.ELEMENT.,$,$,$,$,$);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCCARTESIANPOINT((4.,0.));
#10=IFCCARTESIANPOINT((4.,1.));
#11=IFCCARTESIANPOINT((0.,1.));
#12=IFCPOLYLINE((#8,#9,#10,#11,#8));
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);
#14=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCEXTRUDEDAREASOLID(#13,#15,#16,2.);
#18=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#17));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT(#34,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'box',$,$,#22,#19,$,$);
ENDSEC;
END-ISO-10303-21;
"##
    )
}

/// Site rotated 30 degrees about Z (RefDirection = (cos30, sin30, 0)) AND
/// translated: exercises BOTH conditions of the site_local tier.
const ROTATED_SITE_PLACEMENT: &str = r##"#30=IFCCARTESIANPOINT((10.,20.,0.));
#31=IFCDIRECTION((0.,0.,1.));
#32=IFCDIRECTION((0.866025403784439,0.5,0.));
#33=IFCAXIS2PLACEMENT3D(#30,#31,#32);"##;

/// Site translated but NOT rotated: site_local tier with the identity
/// fast-out inside `apply_inverse_rotation_in_place`.
const TRANSLATED_SITE_PLACEMENT: &str = r##"#30=IFCCARTESIANPOINT((10.,20.,0.));
#33=IFCAXIS2PLACEMENT3D(#30,$,$);"##;

/// Fully identity site placement: must NOT trigger the site_local tier.
const IDENTITY_SITE_PLACEMENT: &str = r##"#30=IFCCARTESIANPOINT((0.,0.,0.));
#33=IFCAXIS2PLACEMENT3D(#30,$,$);"##;

/// The proxy's occurrence meshes (express id #23, geometry_class 0).
fn proxy_meshes(result: &ProcessingResult) -> Vec<&MeshData> {
    let meshes: Vec<&MeshData> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == 23 && m.geometry_class == 0)
        .collect();
    assert!(!meshes.is_empty(), "expected meshes for the proxy (#23)");
    meshes
}

/// Vertices in the serialized frame: `origin + position` (both already in the
/// declared mesh coordinate space).
fn frame_vertices(meshes: &[&MeshData]) -> Vec<[f64; 3]> {
    let mut out = Vec::new();
    for m in meshes {
        for p in m.positions.chunks_exact(3) {
            out.push([
                p[0] as f64 + m.origin[0],
                p[1] as f64 + m.origin[1],
                p[2] as f64 + m.origin[2],
            ]);
        }
    }
    assert!(!out.is_empty(), "proxy meshes have vertices");
    out
}

fn bbox(v: &[[f64; 3]]) -> ([f64; 3], [f64; 3]) {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for p in v {
        for i in 0..3 {
            mn[i] = mn[i].min(p[i]);
            mx[i] = mx[i].max(p[i]);
        }
    }
    (mn, mx)
}

fn approx(got: [f64; 3], want: [f64; 3], what: &str) {
    for i in 0..3 {
        assert!(
            (got[i] - want[i]).abs() < EPS,
            "{what}: axis {i} got {} want {}",
            got[i],
            want[i]
        );
    }
}

/// Every normal must be unit length; in the site-local frame the box faces
/// are axis-aligned, so each normal must also be a signed basis vector. A
/// missed inverse rotation leaves normals yawed 30 degrees and fails here.
fn assert_normals_unit_and_axis_aligned(meshes: &[&MeshData]) {
    let mut checked = 0usize;
    for m in meshes {
        for n in m.normals.chunks_exact(3) {
            checked += 1;
            let (x, y, z) = (n[0] as f64, n[1] as f64, n[2] as f64);
            let len = (x * x + y * y + z * z).sqrt();
            assert!(
                (len - 1.0).abs() < 1e-3,
                "normal not unit length: ({x}, {y}, {z})"
            );
            let ax = [x.abs(), y.abs(), z.abs()];
            let max = ax[0].max(ax[1]).max(ax[2]);
            let off_axis: f64 = ax.iter().sum::<f64>() - max;
            assert!(
                max > 0.999 && off_axis < 1e-3,
                "normal not axis-aligned in the site-local frame: ({x}, {y}, {z})"
            );
        }
    }
    assert!(checked > 0, "no normals emitted; the axis-alignment check must not pass vacuously");
}

/// Assert every mesh vertex coincides with one of the 8 `expected` corners.
fn assert_vertices_match_corners(verts: &[[f64; 3]], expected: &[[f64; 3]], what: &str) {
    for v in verts {
        let matched = expected.iter().any(|e| {
            (v[0] - e[0]).abs() < EPS && (v[1] - e[1]).abs() < EPS && (v[2] - e[2]).abs() < EPS
        });
        assert!(
            matched,
            "{what}: vertex ({}, {}, {}) matches no expected box corner",
            v[0], v[1], v[2]
        );
    }
}

#[test]
fn rotated_site_meshes_are_inverse_rotated_into_site_local_frame() {
    let ifc = model(ROTATED_SITE_PLACEMENT);
    let result = process_geometry(&ifc);

    // Tier selection: non-identity site translation picks site_local.
    assert_eq!(
        result.mesh_coordinate_space.as_deref(),
        Some("site_local"),
        "non-identity site translation must select the site_local tier"
    );
    approx(
        result.metadata.coordinate_info.origin_shift,
        SITE_T,
        "origin_shift (RTC) must be the site translation",
    );

    // The resolved site transform must carry the ACTUAL 30 degree yaw; if the
    // fixture's RefDirection failed to parse this would silently degrade to
    // identity and the assertions below would prove nothing.
    let c = 30f64.to_radians().cos();
    let s = 30f64.to_radians().sin();
    let st = result.site_transform.as_ref().expect("site transform resolved");
    assert_eq!(st.len(), 16, "column-major 4x4");
    for (idx, want) in [(0, c), (1, s), (4, -s), (5, c), (10, 1.0)] {
        assert!(
            (st[idx] - want).abs() < 1e-9,
            "site_transform[{idx}] got {} want {want}",
            st[idx]
        );
    }
    approx([st[12], st[13], st[14]], SITE_T, "site_transform translation");

    // Compute the expected site-local corners BY HAND: place each local box
    // corner into the world (w = t + R * l), then inverse-rotate it back
    // around the site origin (R_transpose * (w - t)). This is the frame the
    // pipeline claims to serialize; nothing below assumes the rotation
    // cancels, the arithmetic performs it.
    let mut expected = Vec::with_capacity(8);
    for xi in [0.0, BOX[0]] {
        for yi in [0.0, BOX[1]] {
            for zi in [0.0, BOX[2]] {
                let (lx, ly, lz) = (xi, yi, zi);
                // Forward: world = t + R * l (yaw about Z).
                let wx = SITE_T[0] + c * lx - s * ly;
                let wy = SITE_T[1] + s * lx + c * ly;
                let wz = SITE_T[2] + lz;
                // Inverse: site_local = R_transpose * (world - t).
                let dx = wx - SITE_T[0];
                let dy = wy - SITE_T[1];
                let dz = wz - SITE_T[2];
                expected.push([c * dx + s * dy, -s * dx + c * dy, dz]);
            }
        }
    }

    let meshes = proxy_meshes(&result);
    let verts = frame_vertices(&meshes);
    let (mn, mx) = bbox(&verts);
    approx(mn, [0.0, 0.0, 0.0], "site-local AABB min");
    approx(mx, BOX, "site-local AABB max");
    assert_vertices_match_corners(&verts, &expected, "rotated site");
    assert_normals_unit_and_axis_aligned(&meshes);
}

#[test]
fn translated_only_site_still_selects_site_local_and_keeps_axes() {
    let ifc = model(TRANSLATED_SITE_PLACEMENT);
    let result = process_geometry(&ifc);

    assert_eq!(result.mesh_coordinate_space.as_deref(), Some("site_local"));
    approx(
        result.metadata.coordinate_info.origin_shift,
        SITE_T,
        "origin_shift (RTC) must be the site translation",
    );

    let meshes = proxy_meshes(&result);
    let verts = frame_vertices(&meshes);
    let (mn, mx) = bbox(&verts);
    approx(mn, [0.0, 0.0, 0.0], "translated-site AABB min");
    approx(mx, BOX, "translated-site AABB max");
    assert_normals_unit_and_axis_aligned(&meshes);
}

#[test]
fn identity_site_passes_through_unchanged() {
    let ifc = model(IDENTITY_SITE_PLACEMENT);
    let result = process_geometry(&ifc);

    // No site translation and no large coordinates: raw_ifc, zero RTC.
    assert_eq!(
        result.mesh_coordinate_space.as_deref(),
        Some("raw_ifc"),
        "identity site must not trigger the site_local tier"
    );
    approx(
        result.metadata.coordinate_info.origin_shift,
        [0.0, 0.0, 0.0],
        "identity site keeps a zero origin shift",
    );

    let meshes = proxy_meshes(&result);
    let verts = frame_vertices(&meshes);
    let (mn, mx) = bbox(&verts);
    approx(mn, [0.0, 0.0, 0.0], "identity AABB min");
    approx(mx, BOX, "identity AABB max");
    assert_normals_unit_and_axis_aligned(&meshes);
}
