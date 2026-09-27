// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5698: raw-world tessellated, Brep and surface-model items must subtract
//! the model RTC offset in f64 BEFORE narrowing to f32.
//!
//! At LV95 magnitude (2,600,000 m) one f32 ULP is 0.25 m, and 256 mm in a
//! millimetre file. The wholly synthetic feature below is 12 x 7 x 5 mm, so a
//! processor that narrows first collapses it before any later subtraction.
//! Every case is compared against a near-origin counterpart of the same
//! geometry, and against the authored corners as an independent oracle.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{build_texture_index, GeometryRouter, Mesh};

const SITE: [f64; 3] = [2_600_000.0, 1_200_000.0, 0.0];

/// Non-dyadic, sub-ULP box corners in metres (world frame, relative to SITE).
const FEATURE: [[f64; 3]; 8] = [
    [0.4, 0.3, 0.2],
    [0.412, 0.3, 0.2],
    [0.412, 0.307, 0.2],
    [0.4, 0.307, 0.2],
    [0.4, 0.3, 0.205],
    [0.412, 0.3, 0.205],
    [0.412, 0.307, 0.205],
    [0.4, 0.307, 0.205],
];
const FACES: &[&[usize]] = &[
    &[4, 3, 2, 1],
    &[5, 6, 7, 8],
    &[1, 2, 6, 5],
    &[2, 3, 7, 6],
    &[3, 4, 8, 7],
    &[4, 1, 5, 8],
];

#[derive(Clone, Copy, Debug)]
enum Shape {
    Triangulated,
    Tin,
    Polygonal,
    Brep,
    FaceBased,
    ShellBased,
    /// A shell-based surface model whose face is a bilinear B-spline patch.
    ShellBasedBSpline,
    /// An `IfcAdvancedBrep` over the same B-spline advanced face.
    AdvancedBrep,
    /// A bare B-spline surface item (a `Surface3D` representation).
    BSplineSurface,
    Structural,
}

const SHAPES: [Shape; 10] = [
    Shape::Triangulated,
    Shape::Tin,
    Shape::Polygonal,
    Shape::Brep,
    Shape::FaceBased,
    Shape::ShellBased,
    Shape::ShellBasedBSpline,
    Shape::AdvancedBrep,
    Shape::BSplineSurface,
    Shape::Structural,
];

/// The authored corners a shape emits (the patch and the face use the base).
fn corners(shape: Shape) -> &'static [[f64; 3]] {
    match shape {
        Shape::ShellBasedBSpline
        | Shape::AdvancedBrep
        | Shape::BSplineSurface
        | Shape::Structural => &FEATURE[..4],
        _ => &FEATURE,
    }
}

/// A frame for the synthetic element: the placement rotates 90 degrees about
/// Z when `rotated`, so object coordinates are the inverse-rotated world ones.
#[derive(Clone, Copy)]
struct Frame {
    /// Offset added to the feature before it is written (metres).
    world_offset: [f64; 3],
    rotated: bool,
    /// File length unit in metres.
    scale: f64,
}

impl Frame {
    /// World metres to object file units: `R^-1 (offset + p) / scale`.
    fn object(&self, p: [f64; 3]) -> [f64; 3] {
        let w = [
            p[0] + self.world_offset[0],
            p[1] + self.world_offset[1],
            p[2] + self.world_offset[2],
        ];
        let o = if self.rotated { [w[1], -w[0], w[2]] } else { w };
        o.map(|v| v / self.scale)
    }
}

fn triple(point: [f64; 3]) -> String {
    format!("({:.6},{:.6},{:.6})", point[0], point[1], point[2])
}

fn refs(ids: impl Iterator<Item = usize>) -> String {
    ids.map(|id| format!("#{id}")).collect::<Vec<_>>().join(",")
}

/// One element with one representation item of `shape`, at `frame`.
fn fixture(shape: Shape, frame: Frame, textured: bool) -> String {
    let direction = if frame.rotated {
        "(0.,1.,0.)"
    } else {
        "(1.,0.,0.)"
    };
    let mut s = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,#4);\
         #3=IFCLOCALPLACEMENT($,#2);#4=IFCDIRECTION({direction});"
    );
    let points: Vec<[f64; 3]> = FEATURE.iter().map(|&p| frame.object(p)).collect();
    for (i, &p) in points.iter().enumerate() {
        s.push_str(&format!("#{}=IFCCARTESIANPOINT({});", i + 10, triple(p)));
    }
    for (i, face) in FACES.iter().enumerate() {
        s.push_str(&format!(
            "#{}=IFCPOLYLOOP(({}));#{}=IFCFACEOUTERBOUND(#{},.T.);#{}=IFCFACE((#{}));",
            i + 200,
            refs(face.iter().map(|v| v + 9)),
            i + 300,
            i + 200,
            i + 400,
            i + 300,
        ));
    }
    let coords = points
        .iter()
        .copied()
        .map(triple)
        .collect::<Vec<_>>()
        .join(",");
    s.push_str(&format!("#700=IFCCARTESIANPOINTLIST3D(({coords}),$);"));
    let triangles = FACES
        .iter()
        .flat_map(|f| [(f[0], f[1], f[2]), (f[0], f[2], f[3])])
        .map(|(a, b, c)| format!("({a},{b},{c})"))
        .collect::<Vec<_>>()
        .join(",");
    let all_faces = refs(400..400 + FACES.len());
    s.push_str(&format!("#800=IFCCLOSEDSHELL(({all_faces}));"));
    let rep_type = match shape {
        Shape::Triangulated => {
            s.push_str(&format!(
                "#900=IFCTRIANGULATEDFACESET(#700,$,.T.,({triangles}),$);"
            ));
            "Tessellation"
        }
        Shape::Tin => {
            let flags = vec!["0"; FACES.len() * 2].join(",");
            s.push_str(&format!(
                "#900=IFCTRIANGULATEDIRREGULARNETWORK(#700,$,.F.,({triangles}),$,({flags}));"
            ));
            "Tessellation"
        }
        Shape::Polygonal => {
            for (i, face) in FACES.iter().enumerate() {
                let indices = face
                    .iter()
                    .map(usize::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                s.push_str(&format!(
                    "#{}=IFCINDEXEDPOLYGONALFACE(({indices}));",
                    i + 100
                ));
            }
            s.push_str(&format!(
                "#900=IFCPOLYGONALFACESET(#700,.T.,({}),$);",
                refs(100..100 + FACES.len())
            ));
            "Tessellation"
        }
        Shape::Brep => {
            s.push_str("#900=IFCFACETEDBREP(#800);");
            "Brep"
        }
        Shape::FaceBased => {
            s.push_str(&format!(
                "#801=IFCCONNECTEDFACESET(({all_faces}));#900=IFCFACEBASEDSURFACEMODEL((#801));"
            ));
            "SurfaceModel"
        }
        Shape::ShellBased => {
            s.push_str("#900=IFCSHELLBASEDSURFACEMODEL((#800));");
            "SurfaceModel"
        }
        Shape::ShellBasedBSpline => {
            // Degree 1 x 1 over the base corners: u runs 1->2, v runs 1->4.
            s.push_str(
                "#801=IFCBSPLINESURFACEWITHKNOTS(1,1,((#10,#13),(#11,#12)),.UNSPECIFIED.,\
                 .F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\
                 #802=IFCADVANCEDFACE((#300),#801,.T.);#803=IFCOPENSHELL((#802));\
                 #900=IFCSHELLBASEDSURFACEMODEL((#803));",
            );
            "SurfaceModel"
        }
        Shape::BSplineSurface => {
            s.push_str(
                "#900=IFCBSPLINESURFACEWITHKNOTS(1,1,((#10,#13),(#11,#12)),.UNSPECIFIED.,\
                 .F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);",
            );
            "Surface3D"
        }
        Shape::AdvancedBrep => {
            s.push_str(
                "#801=IFCBSPLINESURFACEWITHKNOTS(1,1,((#10,#13),(#11,#12)),.UNSPECIFIED.,\
                 .F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.);\
                 #802=IFCADVANCEDFACE((#300),#801,.T.);#803=IFCCLOSEDSHELL((#802));\
                 #900=IFCADVANCEDBREP(#803);",
            );
            "AdvancedBrep"
        }
        Shape::Structural => {
            s.push_str("#801=IFCAXIS2PLACEMENT3D(#10,$,$);#802=IFCPLANE(#801);#900=IFCFACESURFACE((#300),#802,.T.);");
            "Face"
        }
    };
    if textured {
        let uvs = (0..FEATURE.len())
            .map(|i| format!("({}.,{}.)", i % 2, (i / 2) % 2))
            .collect::<Vec<_>>()
            .join(",");
        s.push_str(&format!(
            "#950=IFCIMAGETEXTURE(.T.,.T.,$,$,$,'feature.png');\
             #951=IFCTEXTUREVERTEXLIST(({uvs}));\
             #952=IFCINDEXEDTRIANGLETEXTUREMAP((#950),#900,#951,$);"
        ));
    }
    let (rep, element) = if matches!(shape, Shape::Structural) {
        (
            "IFCTOPOLOGYREPRESENTATION",
            "IFCSTRUCTURALSURFACEMEMBER('0000000000000000000000',$,'Surface',$,$,#3,#1001,.SHELL.,0.2)",
        )
    } else {
        (
            "IFCSHAPEREPRESENTATION",
            "IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Member',$,$,#3,#1001,$)",
        )
    };
    s.push_str(&format!(
        "#1000={rep}($,'Body','{rep_type}',(#900));\
         #1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000));#1002={element};"
    ));
    s
}

/// Mesh the element through the merged or the per-item router entry point.
fn process(source: &str, frame: Frame, rtc: [f64; 3], framed: bool, submeshes: bool) -> Mesh {
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(1002).unwrap();
    let mut router = GeometryRouter::with_scale_and_local_frame(frame.scale, framed);
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

fn world(mesh: &Mesh, vertex: &[f32], axis: usize) -> f64 {
    vertex[axis] as f64 + mesh.origin[axis]
}

/// Every authored corner is present in world/RTC coordinates. 10 µm covers
/// the B-spline sampler's end-of-domain clamp; one f32 ULP here is 0.25 m.
fn assert_corners(mesh: &Mesh, expected: &[[f64; 3]], label: &str) {
    for p in expected {
        assert!(
            mesh.positions
                .chunks_exact(3)
                .any(|v| (0..3).all(|axis| (world(mesh, v, axis) - p[axis]).abs() < 1e-5)),
            "{label}: authored corner {p:?} lost"
        );
    }
}

/// The raw-world mesh equals its near-origin counterpart: topology, vertices
/// and normals. Its bounds stay in the raw object frame.
fn assert_matches_counterpart(raw: &Mesh, near: &Mesh, frame: Frame, shape: Shape, label: &str) {
    assert!(!near.indices.is_empty(), "{label}: counterpart is empty");
    assert_eq!(raw.indices, near.indices, "{label}: topology changed");
    assert_eq!(raw.positions.len(), near.positions.len(), "{label}");
    for (r, n) in raw
        .positions
        .chunks_exact(3)
        .zip(near.positions.chunks_exact(3))
    {
        for axis in 0..3 {
            let delta = world(raw, r, axis) - world(near, n, axis);
            assert!(delta.abs() < 1e-6, "{label}: axis {axis} off by {delta} m");
        }
    }
    assert_eq!(raw.normals.len(), near.normals.len(), "{label}: normals");
    for (r, n) in raw.normals.iter().zip(&near.normals) {
        assert!((r - n).abs() < 1e-4, "{label}: normal {r} vs {n}");
    }

    // Object-space bounds (#1474) enclose the authored raw object extent,
    // tightly, rather than describing the rebased RTC frame.
    let bounds = raw.local_bounds.expect("raw mesh publishes local bounds");
    for axis in 0..3 {
        let values = corners(shape)
            .iter()
            .map(|&p| frame.object(p)[axis] * frame.scale);
        let (min, max) = values.fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)));
        let (lo, hi) = (bounds[axis] as f64, bounds[axis + 3] as f64);
        // Slack for the authored decimal's own f32 rounding, not for a frame.
        let slack = |v: f64| 1e-6 + v.abs() * f32::EPSILON as f64;
        assert!(
            lo <= min + slack(min) && hi >= max - slack(max),
            "{label}: bounds {lo}..{hi} miss {min}..{max}"
        );
        assert!(
            hi - lo <= max - min + 1.0,
            "{label}: bounds {lo}..{hi} are loose"
        );
        if max > min {
            assert!(hi > lo, "{label}: axis {axis} bounds collapsed");
        }
    }
}

/// Raw national-grid coordinates keep sub-ULP detail for every covered item
/// type, in metres and millimetres, identity and rotated placements, merged
/// and per-item output, with and without the local-origin frame.
#[test]
fn issue_5698_raw_world_items_rebase_before_f32_narrowing() {
    for shape in SHAPES {
        for scale in [1.0, 0.001] {
            for rotated in [false, true] {
                let raw = Frame {
                    world_offset: SITE,
                    rotated,
                    scale,
                };
                let near = Frame {
                    world_offset: [0.0; 3],
                    rotated,
                    scale,
                };
                let raw_source = fixture(shape, raw, false);
                let near_source = fixture(shape, near, false);
                for framed in [false, true] {
                    for submeshes in [false, true] {
                        let label = format!(
                            "{shape:?} scale={scale} rotated={rotated} framed={framed} \
                             submeshes={submeshes}"
                        );
                        let raw_mesh = process(&raw_source, raw, SITE, framed, submeshes);
                        let near_mesh = process(&near_source, near, [0.0; 3], framed, submeshes);
                        assert_corners(&raw_mesh, corners(shape), &label);
                        assert_matches_counterpart(&raw_mesh, &near_mesh, raw, shape, &label);
                    }
                }
            }
        }
    }
}

/// A textured raw-world face set keeps its UV channel and its detail, and
/// rebases in its own frame under a rotated placement.
#[test]
fn issue_5698_textured_raw_world_face_set_keeps_uvs_and_detail() {
    for rotated in [false, true] {
        let frame = Frame {
            world_offset: SITE,
            rotated,
            scale: 1.0,
        };
        assert_textured_detail(fixture(Shape::Triangulated, frame, true), rotated, true);
        // A TIN is a valid texture-map target the UV path does not mesh; it
        // must still rebase in its own frame rather than vanish (#5698).
        assert_textured_detail(fixture(Shape::Tin, frame, true), rotated, false);
    }
}

fn assert_textured_detail(source: String, rotated: bool, keeps_uvs: bool) {
    let mut decoder = EntityDecoder::new(&source);
    let textures = build_texture_index(source.as_bytes(), &mut decoder);
    assert_eq!(textures.len(), 1, "fixture must declare one texture map");
    let element = decoder.decode_by_id(1002).unwrap();
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, true);
    router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
    let meshes = router
        .process_element_with_submeshes_textured(&element, &mut decoder, &textures)
        .unwrap();
    assert_eq!(meshes.sub_meshes.len(), 1);
    let sub = &meshes.sub_meshes[0];
    if keeps_uvs {
        let uvs = sub.uvs.as_ref().expect("textured sub-mesh keeps its UVs");
        assert_eq!(uvs.len() / 2, sub.mesh.positions.len() / 3);
    }
    assert_corners(
        &sub.mesh,
        &FEATURE,
        &format!("textured face set rotated={rotated}"),
    );
}

/// A raw-world item and a local item of one element keep their own frames:
/// the raw item is rebased once, the local one only by the final placement.
#[test]
fn issue_5698_mixed_raw_and_local_items_keep_their_frames() {
    let metres = |world_offset| Frame {
        world_offset,
        rotated: false,
        scale: 1.0,
    };
    let raw = fixture(Shape::Triangulated, metres(SITE), false);
    // A second item, with its own IDs, holding the same feature near the origin.
    let local_item = fixture(Shape::Polygonal, metres([0.0; 3]), false)
        .split(';')
        .filter(|entity| {
            entity
                .strip_prefix('#')
                .and_then(|rest| rest.split('=').next())
                .and_then(|id| id.parse::<u32>().ok())
                .is_some_and(|id| (10..1000).contains(&id))
        })
        .map(|entity| shift_ids(entity, 5000) + ";")
        .collect::<String>();
    let mixed = raw.replace("(#900));#1001", "(#900,#5900));#1001") + &local_item;
    let local_world = FEATURE.map(|p| [p[0] - SITE[0], p[1] - SITE[1], p[2] - SITE[2]]);
    for framed in [false, true] {
        let merged = process(&mixed, metres(SITE), SITE, framed, false);
        assert_eq!(merged.indices.len(), 2 * 36, "both items survive the merge");
        // The local item sits at the file origin, i.e. -SITE in the RTC frame,
        // where one f32 ULP is 0.25 m. A double rebase would put it at -2*SITE;
        // a missed one would leave the raw item at +SITE.
        let tolerance = if framed {
            // One merged local frame spans both items, 2,600 km apart, so
            // neither can keep sub-ULP detail; frames must still be right.
            0.25
        } else {
            1e-6
        };
        for (expected, bound) in [(&FEATURE, tolerance), (&local_world, 0.25)] {
            for p in expected {
                assert!(
                    merged.positions.chunks_exact(3).any(|v| {
                        (0..3).all(|axis| (world(&merged, v, axis) - p[axis]).abs() <= bound)
                    }),
                    "framed={framed}: vertex {p:?} moved or lost"
                );
            }
        }
    }
}

/// Identical raw-world items in two elements still share one direct-solid
/// `rep_identity` (GLB/wasm instancing), in the model frame and when both
/// elements rebase in the same rotated frame.
#[test]
fn issue_5698_identical_raw_items_share_rep_identity() {
    for rotated in [false, true] {
        let frame = Frame {
            world_offset: SITE,
            rotated,
            scale: 1.0,
        };
        let first = fixture(Shape::Triangulated, frame, false);
        // A byte-identical copy of the whole element under shifted IDs.
        let second = first
            .split(';')
            .filter(|entity| !entity.is_empty())
            .map(|entity| shift_ids(entity, 5000) + ";")
            .collect::<String>();
        let source = format!("{first}{second}");
        let mut decoder = EntityDecoder::new(&source);
        let mut router = GeometryRouter::with_scale_and_local_frame(1.0, true);
        router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
        let identity = |id: u32, decoder: &mut EntityDecoder| {
            let element = decoder.decode_by_id(id).unwrap();
            let meshes = router
                .process_element_with_submeshes(&element, decoder)
                .unwrap();
            assert_eq!(meshes.sub_meshes.len(), 1);
            let mesh = &meshes.sub_meshes[0].mesh;
            assert_corners(mesh, &FEATURE, &format!("element #{id} rotated={rotated}"));
            mesh.instance_meta
                .as_ref()
                .expect("a single raw solid is instanceable")
                .rep_identity
        };
        let a = identity(1002, &mut decoder);
        let b = identity(6002, &mut decoder);
        assert_eq!(
            a, b,
            "rotated={rotated}: identical items must share rep_identity"
        );
    }
}

/// A raw item inside a mapped item keeps object-frame bounds that follow
/// its `MappingTarget` into the element frame.
/// Per-item (sub-mesh) output only: the merged mapped-source cache meshes its
/// items unshifted, as it did before this change.
#[test]
fn issue_5698_mapped_raw_item_bounds_follow_the_mapping_target() {
    let frame = Frame {
        world_offset: SITE,
        rotated: false,
        scale: 1.0,
    };
    let target = [10.0, 20.0, 0.0];
    let source = fixture(Shape::Triangulated, frame, false).replace(
        "#1000=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#900));",
        "#1000=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#1012));\
         #1010=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#900));\
         #1011=IFCREPRESENTATIONMAP(#2,#1010);#1013=IFCCARTESIANPOINT((10.,20.,0.));\
         #1014=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1013,1.,$);\
         #1012=IFCMAPPEDITEM(#1011,#1014);",
    );
    let shifted = FEATURE.map(|p| [p[0] + target[0], p[1] + target[1], p[2] + target[2]]);
    for submeshes in [true] {
        let mesh = process(&source, frame, SITE, true, submeshes);
        assert_corners(
            &mesh,
            &shifted,
            &format!("mapped raw item submeshes={submeshes}"),
        );
        let bounds = mesh.local_bounds.expect("mapped raw item publishes bounds");
        for axis in 0..3 {
            let values = shifted.iter().map(|p| p[axis] + SITE[axis]);
            let (min, max) =
                values.fold((f64::MAX, f64::MIN), |(lo, hi), v| (lo.min(v), hi.max(v)));
            let (lo, hi) = (bounds[axis] as f64, bounds[axis + 3] as f64);
            let slack = |v: f64| 1e-6 + v.abs() * f32::EPSILON as f64;
            assert!(
                lo <= min + slack(min) && hi >= max - slack(max) && hi - lo <= max - min + 1.0,
                "submeshes={submeshes} axis {axis}: bounds {lo}..{hi} do not enclose {min}..{max}"
            );
        }
    }
}

/// A rotated opening whose cutter is a raw national-grid face set lands on
/// the authored world geometry: the cutter rebases in its own frame (#5698).
#[test]
fn issue_5698_rotated_raw_opening_cutter_rebases_in_its_frame() {
    let frame = Frame {
        world_offset: SITE,
        rotated: true,
        scale: 1.0,
    };
    let source = fixture(Shape::Triangulated, frame, false);
    let mut decoder = EntityDecoder::new(&source);
    let opening = decoder.decode_by_id(1002).unwrap();
    let mut router = GeometryRouter::with_scale(1.0);
    router.set_rtc_offset((SITE[0], SITE[1], SITE[2]));
    let meshes = router
        .get_opening_item_meshes_world(&opening, &mut decoder)
        .unwrap();
    assert_eq!(meshes.len(), 1);
    assert_corners(&meshes[0], &FEATURE, "rotated raw opening cutter");
}

/// Offset every `#id` reference in one STEP entity.
fn shift_ids(entity: &str, offset: u32) -> String {
    let mut out = String::new();
    let mut chars = entity.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == '#' {
            let mut digits = String::new();
            while chars.peek().is_some_and(char::is_ascii_digit) {
                digits.push(chars.next().unwrap());
            }
            out.push_str(&(digits.parse::<u32>().unwrap() + offset).to_string());
        }
    }
    out
}
