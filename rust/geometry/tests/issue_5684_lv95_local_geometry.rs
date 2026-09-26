// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5684: a national-grid placement must not quantize kilometre-scale LOCAL
//! vertices by subtracting the site offset before applying the placement.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};

const SITE: [f64; 3] = [2_600_000.0, 1_200_000.0, 0.0];

// Wholly synthetic closed box: centimetre-scale dimensions at a kilometre-scale
// local offset. Adding a national-grid placement must preserve its eight corners.
const MEMBER_POINTS: [[f64; 3]; 8] = [
    [3500.0, 2300.0, 1190.0],
    [3500.03125, 2300.0, 1190.0],
    [3500.03125, 2300.0625, 1190.0],
    [3500.0, 2300.0625, 1190.0],
    [3500.0, 2300.0, 1190.125],
    [3500.03125, 2300.0, 1190.125],
    [3500.03125, 2300.0625, 1190.125],
    [3500.0, 2300.0625, 1190.125],
];
const MEMBER_FACES: &[&[usize]] = &[
    &[4, 3, 2, 1],
    &[5, 6, 7, 8],
    &[1, 2, 6, 5],
    &[2, 3, 7, 6],
    &[3, 4, 8, 7],
    &[4, 1, 5, 8],
];

#[derive(Clone, Copy, Debug)]
enum Shape {
    Polygonal,
    Brep,
    FaceBased,
    ShellBased,
    Structural,
}

/// Format a synthetic point without changing its intended small dimensions.
fn triple(point: [f64; 3]) -> String {
    format!("({:.9},{:.9},{:.9})", point[0], point[1], point[2])
}

/// Assemble one representation around the same placement and point set.
fn fixture(
    shape: Shape,
    points: &[[f64; 3]],
    faces: &[&[usize]],
    site: [f64; 3],
    rotated: bool,
) -> String {
    let direction = if rotated { "(0.,1.,0.)" } else { "(1.,0.,0.)" };
    let mut source = format!(
        "#1=IFCCARTESIANPOINT({});#2=IFCAXIS2PLACEMENT3D(#1,$,#4);\
         #3=IFCLOCALPLACEMENT($,#2);#4=IFCDIRECTION({direction});",
        triple(site),
    );
    for (index, &point) in points.iter().enumerate() {
        source.push_str(&format!(
            "#{}=IFCCARTESIANPOINT({});",
            index + 10,
            triple(point)
        ));
    }
    for (index, face) in faces.iter().enumerate() {
        let refs = face
            .iter()
            .map(|v| format!("#{}", v + 9))
            .collect::<Vec<_>>()
            .join(",");
        source.push_str(&format!(
            "#{}=IFCPOLYLOOP(({refs}));#{}=IFCFACEOUTERBOUND(#{},.T.);\
             #{}=IFCFACE((#{}));",
            index + 200,
            index + 300,
            index + 200,
            index + 400,
            index + 300,
        ));
        let indices = face
            .iter()
            .map(usize::to_string)
            .collect::<Vec<_>>()
            .join(",");
        source.push_str(&format!(
            "#{}=IFCINDEXEDPOLYGONALFACE(({indices}));",
            index + 100
        ));
    }
    let face_refs = (0..faces.len())
        .map(|i| format!("#{}", i + 400))
        .collect::<Vec<_>>()
        .join(",");
    source.push_str(&format!("#800=IFCCLOSEDSHELL(({face_refs}));"));
    let rep_type = match shape {
        Shape::Polygonal => {
            let coords = points
                .iter()
                .copied()
                .map(triple)
                .collect::<Vec<_>>()
                .join(",");
            let indices = (0..faces.len())
                .map(|i| format!("#{}", i + 100))
                .collect::<Vec<_>>()
                .join(",");
            source.push_str(&format!(
                "#700=IFCCARTESIANPOINTLIST3D(({coords}),$);\
                 #900=IFCPOLYGONALFACESET(#700,.T.,({indices}),$);",
            ));
            "Tessellation"
        }
        Shape::Brep => {
            source.push_str("#900=IFCFACETEDBREP(#800);");
            "Brep"
        }
        Shape::FaceBased => {
            source.push_str(&format!(
                "#801=IFCCONNECTEDFACESET(({face_refs}));#900=IFCFACEBASEDSURFACEMODEL((#801));"
            ));
            "SurfaceModel"
        }
        Shape::ShellBased => {
            source.push_str("#900=IFCSHELLBASEDSURFACEMODEL((#800));");
            "SurfaceModel"
        }
        Shape::Structural => {
            source.push_str("#801=IFCAXIS2PLACEMENT3D(#10,$,$);#802=IFCPLANE(#801);#900=IFCFACESURFACE((#300),#802,.T.);");
            "Face"
        }
    };
    let rep = if matches!(shape, Shape::Structural) {
        "IFCTOPOLOGYREPRESENTATION"
    } else {
        "IFCSHAPEREPRESENTATION"
    };
    source.push_str(&format!(
        "#1000={rep}($,'Body','{rep_type}',(#900));#1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000));",
    ));
    source.push_str(if matches!(shape, Shape::Structural) {
        "#1002=IFCSTRUCTURALSURFACEMEMBER('0000000000000000000000',$,'Surface',$,$,#3,#1001,.SHELL.,0.2);"
    } else {
        "#1002=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Member',$,$,#3,#1001,$);"
    });
    source
}

/// Exercise the public merged or per-item router entry point with an RTC frame.
fn process(source: &str, rtc: [f64; 3], framed: bool, submeshes: bool) -> Mesh {
    process_scaled(source, rtc, framed, submeshes, 1.0)
}

/// Run the same entry point with an explicit file-unit-to-metre scale.
fn process_scaled(source: &str, rtc: [f64; 3], framed: bool, submeshes: bool, scale: f64) -> Mesh {
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(1002).unwrap();
    let mut router = GeometryRouter::with_scale_and_local_frame(scale, framed);
    router.set_rtc_offset((rtc[0], rtc[1], rtc[2]));
    if submeshes {
        let mut meshes = router
            .process_element_with_submeshes(&element, &mut decoder)
            .unwrap();
        assert_eq!(meshes.sub_meshes.len(), 1);
        meshes.sub_meshes.remove(0).mesh
    } else {
        router.process_element(&element, &mut decoder).unwrap()
    }
}

/// Compare topology, recovered vertices and object-space bounds across frames.
fn assert_same_geometry(actual: &Mesh, expected: &Mesh) {
    assert!(!expected.indices.is_empty());
    assert_eq!(
        actual.indices, expected.indices,
        "placement must preserve source topology"
    );
    assert_eq!(actual.positions.len(), expected.positions.len());
    assert_eq!(
        actual.local_bounds, expected.local_bounds,
        "RTC must preserve the published object-space bounds",
    );
    for (a, e) in actual
        .positions
        .chunks_exact(3)
        .zip(expected.positions.chunks_exact(3))
    {
        for axis in 0..3 {
            let delta =
                a[axis] as f64 + actual.origin[axis] - e[axis] as f64 - expected.origin[axis];
            assert!(
                delta.abs() < 0.0005,
                "axis {axis}: placement introduced {delta} m error"
            );
        }
    }
}

/// A national-grid placement preserves the synthetic member's small faces.
#[test]
fn issue_5684_lv95_placement_preserves_synthetic_thin_member() {
    for shape in [
        Shape::Polygonal,
        Shape::Brep,
        Shape::FaceBased,
        Shape::ShellBased,
    ] {
        for rotated in [false, true] {
            let local = fixture(shape, &MEMBER_POINTS, MEMBER_FACES, [0.0; 3], rotated);
            let placed = fixture(shape, &MEMBER_POINTS, MEMBER_FACES, SITE, rotated);
            for framed in [false, true] {
                for submeshes in [false, true] {
                    let expected = process(&local, [0.0; 3], framed, submeshes);
                    let actual = process(&placed, SITE, framed, submeshes);
                    assert_same_geometry(&actual, &expected);
                    // The synthetic box corners are the oracle, independent
                    // of the local-vs-placed differential assertion above.
                    for p in MEMBER_POINTS {
                        let p = if rotated { [-p[1], p[0], p[2]] } else { p };
                        assert!(
                            actual.positions.chunks_exact(3).any(|vertex| {
                                (0..3).all(|axis| {
                                    (vertex[axis] as f64 + actual.origin[axis] - p[axis]).abs()
                                        < 0.0005
                                })
                            }),
                            "{shape:?}: authored vertex {p:?} lost"
                        );
                    }
                }
            }
        }
    }
}

/// A local structural face stays local even with a rotated site placement.
#[test]
fn issue_5684_local_structural_face_does_not_rebase_into_national_grid_magnitude() {
    let points = [
        [3500.0, 2300.0, 1190.0],
        [3500.03125, 2300.0, 1190.0],
        [3500.03125, 2300.0625, 1190.0],
        [3500.0, 2300.0625, 1190.0],
    ];
    for rotated in [false, true] {
        let local = fixture(
            Shape::Structural,
            &points,
            &[&[1, 2, 3, 4]],
            [0.0; 3],
            rotated,
        );
        // The smaller site catches fall-through into generic face processing:
        // world RTC reduces magnitude, but inverse-rotated RTC increases it.
        for site in [SITE, [3500.0, 2300.0, 0.0]] {
            let placed = fixture(Shape::Structural, &points, &[&[1, 2, 3, 4]], site, rotated);
            for submeshes in [false, true] {
                assert_same_geometry(
                    &process(&placed, site, true, submeshes),
                    &process(&local, [0.0; 3], true, submeshes),
                );
            }
        }
    }
}

/// Existing raw-world placement remains correct for every covered item family.
#[test]
fn issue_5684_true_raw_world_geometry_still_rebases() {
    // Pre-f32 paths must retain detail smaller than the f32 ULP at LV95.
    // Exactly representable points assert final RTC placement independently;
    // sub-ULP raw-world detail for every item family is covered by #5698's
    // `issue_5698_raw_world_rtc_before_narrow`.
    for shape in [
        Shape::Polygonal,
        Shape::FaceBased,
        Shape::ShellBased,
        Shape::Brep,
        Shape::Structural,
    ] {
        let width = if matches!(shape, Shape::Brep | Shape::Structural) {
            0.03125
        } else {
            0.5
        };
        let height = 0.5;
        let points = [
            [0.0, 0.0, 0.0],
            [width, 0.0, 0.0],
            [width, height, 0.0],
            [0.0, height, 0.0],
        ];
        let raw = points.map(|p| [p[0] + SITE[0], p[1] + SITE[1], p[2] + SITE[2]]);
        let source = fixture(shape, &raw, &[&[1, 2, 3, 4]], [0.0; 3], false);
        for submeshes in [false, true] {
            let mesh = process(&source, SITE, true, submeshes);
            assert!(!mesh.indices.is_empty());
            for p in points {
                assert!(
                    mesh.positions.chunks_exact(3).any(|v| (0..3).all(|axis| {
                        (v[axis] as f64 + mesh.origin[axis] - p[axis]).abs() < 1e-6
                    })),
                    "{shape:?}: raw-world vertex {p:?} lost"
                );
            }
        }
    }
}

/// Raw millimetre coordinates must be shifted before f32 unit scaling.
/// Scaling first rounded this 256 mm square to 500 x 375 mm on the branch.
#[test]
fn issue_5684_raw_world_millimetres_keep_small_faces() {
    let points = [
        [0.0, 0.0, 0.0],
        [0.256, 0.0, 0.0],
        [0.256, 0.256, 0.0],
        [0.0, 0.256, 0.0],
    ];
    let raw = points.map(|p| {
        [
            (SITE[0] + p[0]) * 1000.0,
            (SITE[1] + p[1]) * 1000.0,
            p[2] * 1000.0,
        ]
    });
    for shape in [Shape::Polygonal, Shape::FaceBased, Shape::ShellBased] {
        let source = fixture(shape, &raw, &[&[1, 2, 3, 4]], [0.0; 3], false);
        for framed in [false, true] {
            for submeshes in [false, true] {
                let mesh = process_scaled(&source, SITE, framed, submeshes, 0.001);
                assert!(!mesh.indices.is_empty(), "{shape:?}: face disappeared");
                for p in points {
                    assert!(
                        mesh.positions.chunks_exact(3).any(|v| {
                            (0..3).all(|axis| {
                                (v[axis] as f64 + mesh.origin[axis] - p[axis]).abs() < 0.0005
                            })
                        }),
                        "{shape:?}: raw millimetre vertex {p:?} lost"
                    );
                }
            }
        }
    }
}

/// Guarded RTC subtraction must leave millimetre-scale site-local items local.
#[test]
fn issue_5684_local_millimetres_keep_site_placement() {
    let points = MEMBER_POINTS.map(|p| [p[0] * 1000.0, p[1] * 1000.0, p[2] * 1000.0]);
    let site = SITE.map(|v| v * 1000.0);
    for shape in [Shape::Polygonal, Shape::FaceBased, Shape::ShellBased] {
        let local = fixture(shape, &points, MEMBER_FACES, [0.0; 3], false);
        let placed = fixture(shape, &points, MEMBER_FACES, site, false);
        for framed in [false, true] {
            for submeshes in [false, true] {
                assert_same_geometry(
                    &process_scaled(&placed, SITE, framed, submeshes, 0.001),
                    &process_scaled(&local, [0.0; 3], framed, submeshes, 0.001),
                );
            }
        }
    }
}

/// Mixed item frames meet only after each has received world placement.
#[test]
fn issue_5684_mixed_item_rtc_frames_merge_after_placement() {
    let raw_points = [
        [SITE[0], SITE[1], 0.0],
        [SITE[0] + 0.5, SITE[1], 0.0],
        [SITE[0] + 0.5, SITE[1] + 0.5, 0.0],
        [SITE[0], SITE[1] + 0.5, 0.0],
    ];
    let raw_source = fixture(Shape::Brep, &raw_points, &[&[1, 2, 3, 4]], SITE, false);
    // A second representation uses its own entity IDs, but the SAME product
    // placement. Shifting all identifiers here keeps the fixture construction
    // independent of the internal number of entities each representation uses.
    let mut shifted_source = String::new();
    let mut chars = raw_source.chars().peekable();
    while let Some(ch) = chars.next() {
        shifted_source.push(ch);
        if ch == '#' {
            let mut digits = String::new();
            while chars.peek().is_some_and(char::is_ascii_digit) {
                digits.push(chars.next().unwrap());
            }
            shifted_source.push_str(&(digits.parse::<u32>().unwrap() + 2000).to_string());
        }
    }
    for (points, faces) in [
        (MEMBER_POINTS.as_slice(), MEMBER_FACES),
        (raw_points.as_slice(), &[&[1, 2, 3, 4][..]][..]),
    ] {
        let local_source = fixture(Shape::Polygonal, points, faces, SITE, false);
        let mixed = local_source.replace(
            "#1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000));",
            "#1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000,#3000));",
        ) + &shifted_source;
        for framed in [false, true] {
            let mesh = process(&mixed, SITE, framed, false);
            let local_mesh = process(&local_source, SITE, framed, false);
            let raw_mesh = process(&raw_source, SITE, framed, false);
            assert_eq!(
                mesh.indices.len(),
                local_mesh.indices.len() + raw_mesh.indices.len()
            );
            for p in points {
                assert!(
                    mesh.positions.chunks_exact(3).any(|v| {
                        (0..3).all(|axis| {
                            (v[axis] as f64 + mesh.origin[axis] - p[axis]).abs() < 0.0005
                        })
                    }),
                    "unshifted item moved or lost precision: {p:?}"
                );
            }
            for p in raw_points {
                // One merged f32 mesh spans millions of metres. Its distant
                // bucket can incur one ULP, but must not acquire another RTC.
                assert!(
                    mesh.positions.chunks_exact(3).any(|v| {
                        (0..3).all(|axis| {
                            (v[axis] as f64 + mesh.origin[axis] - p[axis]).abs() <= 0.25
                        })
                    }),
                    "rebased item moved into a different coordinate frame: {p:?}"
                );
            }
        }
    }
}
