// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Parts-API precision for #6349. The single-mesh contract (explicit
//! error) is witnessed by `tests/issue_6349_single_mesh_span.rs`.
use super::frames_mergeable;
use crate::router::GeometryRouter;
use crate::Mesh;
use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;

const FAR_X: f64 = 5_000_000.123456;
const RTC: [f64; 3] = [5_000_000.0, 0.0, 0.0];

/// Unit box #11 (x/y in [-0.5, 0.5], z in [0, 1]), mapped by #16 to X =
/// FAR_X; #51 is a raw-world tetrahedron at FAR_X. `body` lists the host's
/// items, `opening` the items of opening #40 (0.4 m through-hole #33, #38
/// the same hole mapped to FAR_X).
fn fixture(body: &str, opening: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);\
         #4=IFCDIRECTION((0.,0.,1.));#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);\
         #10=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#11=IFCEXTRUDEDAREASOLID(#10,#2,#4,1.);\
         #12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#11));#13=IFCREPRESENTATIONMAP(#2,#12);\
         #14=IFCCARTESIANPOINT(({FAR_X},0.,0.));#15=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#14,1.,$);\
         #16=IFCMAPPEDITEM(#13,#15);#17=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({body}));\
         #18=IFCPRODUCTDEFINITIONSHAPE($,$,(#17));\
         #20=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Mixed',$,$,#3,#18,$,$);\
         #30=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,0.4,0.4);#31=IFCCARTESIANPOINT((0.,0.,-1.));\
         #32=IFCAXIS2PLACEMENT3D(#31,$,$);#33=IFCEXTRUDEDAREASOLID(#30,#32,#4,3.);\
         #36=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#33));#37=IFCREPRESENTATIONMAP(#2,#36);\
         #38=IFCMAPPEDITEM(#37,#15);#34=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',({opening}));\
         #35=IFCPRODUCTDEFINITIONSHAPE($,$,(#34));\
         #40=IFCOPENINGELEMENT('0000000000000000000001',$,'Opening',$,$,#3,#35,$,.OPENING.);\
         #41=IFCRELVOIDSELEMENT('0000000000000000000002',$,$,$,#20,#40);\
         #50=IFCCARTESIANPOINTLIST3D((({FAR_X},-0.5,0.),({x1},-0.5,0.),({FAR_X},0.5,0.),({FAR_X},-0.5,1.)));\
         #51=IFCTRIANGULATEDFACESET(#50,$,.T.,((1,3,2),(1,2,4),(2,3,4),(1,4,3)),$);",
        x1 = FAR_X + 1.0,
    )
}

fn volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]));
    let six: f64 = mesh.indices.chunks_exact(3).map(|t| {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
    }).sum();
    six.abs() / 6.
}

/// Assert one near part (the unit box at 0) and one far part whose world
/// X extent (`origin + position + rtc`) is `far_x` exactly, to 1e-5 m;
/// y/z match the unit box. Returns (near, far).
fn near_and_far(parts: &[Mesh], rtc: [f64; 3], far_x: (f64, f64), context: &str) -> (Mesh, Mesh) {
    assert_eq!(parts.len(), 2, "{context}: near and far items stay separate parts");
    let (mut near, mut far) = (None, None);
    for part in parts {
        let extent = |axis: usize| {
            let values = part.positions.chunks_exact(3).map(|p| p[axis] as f64 + part.origin[axis] + rtc[axis]);
            values.fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| (lo.min(v), hi.max(v)))
        };
        let is_far = extent(0).0 > 1_000.0;
        let expected = [if is_far { far_x } else { (-0.5, 0.5) }, (-0.5, 0.5), (0.0, 1.0)];
        for (axis, (lo, hi)) in expected.into_iter().enumerate() {
            let (min, max) = extent(axis);
            assert!(
                (min - lo).abs() < 1e-5 && (max - hi).abs() < 1e-5,
                "{context}: axis {axis} spans [{min:.9}, {max:.9}], expected [{lo:.9}, {hi:.9}]"
            );
        }
        let slot = if is_far { &mut far } else { &mut near };
        assert!(slot.replace(part.clone()).is_none(), "{context}: one part per frame");
    }
    (near.unwrap(), far.unwrap())
}

fn parts(router: &GeometryRouter, body: &str) -> Vec<Mesh> {
    let source = fixture(body, "#33");
    let mut decoder = EntityDecoder::new(&source);
    let element = decoder.decode_by_id(20).unwrap();
    router.process_element_parts(&element, &mut decoder).unwrap()
}

fn rtc_router() -> GeometryRouter {
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, true);
    router.set_rtc_offset((RTC[0], RTC[1], RTC[2]));
    router
}

#[test]
fn issue_6349_mapped_far_item_and_near_item_keep_1e_5_m() {
    let mapped = (FAR_X - 0.5, FAR_X + 0.5);
    for body in ["#11,#16", "#16,#11"] {
        for (label, router, rtc) in [
            ("absolute", GeometryRouter::with_scale_and_local_frame(1.0, false), [0.0; 3]),
            ("local frame", GeometryRouter::with_scale_and_local_frame(1.0, true), [0.0; 3]),
            ("rtc + local frame", rtc_router(), RTC),
        ] {
            let parts = parts(&router, body);
            let (near, far) = near_and_far(&parts, rtc, mapped, &format!("{label}, items ({body})"));
            assert!((volume(&near) - 1.0).abs() < 1e-5 && (volume(&far) - 1.0).abs() < 1e-5);
        }
    }
}

#[test]
fn issue_6349_raw_world_item_placed_apart_keeps_1e_5_m() {
    // The RTC-frame (raw-world) bucket meets the placed parts only after
    // placement; 5,000 km from the near box it stays its own part.
    let parts = parts(&rtc_router(), "#11,#51");
    assert!(parts.iter().any(|part| part.rtc_applied));
    near_and_far(&parts, RTC, (FAR_X, FAR_X + 1.0), "raw-world tetrahedron");
}

#[test]
fn issue_6349_items_sharing_a_frame_still_merge_into_one_mesh() {
    for body in ["#11,#33", "#16,#38"] {
        let source = fixture(body, "#33");
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(20).unwrap();
        let router = GeometryRouter::new();
        let parts = router.process_element_parts(&element, &mut decoder).unwrap();
        assert_eq!(parts.len(), 1, "items ({body}) share a frame");
        let single = router.process_element(&element, &mut decoder).unwrap();
        assert_eq!((&single.positions, &single.indices), (&parts[0].positions, &parts[0].indices));
        assert_eq!((single.origin, single.local_bounds), (parts[0].origin, parts[0].local_bounds));
    }
}

#[test]
fn issue_6349_voids_cut_each_frame_part_and_keep_its_precision() {
    // A near cutter holes only the near box; a mixed near+far cutter both.
    for (opening, far_volume) in [("#33", 1.0), ("#33,#38", 0.84)] {
        let source = fixture("#11,#16", opening);
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(20).unwrap();
        let index = FxHashMap::from_iter([(20, vec![40])]);
        let parts = GeometryRouter::new()
            .process_element_with_voids_parts(&element, &mut decoder, &index)
            .unwrap();
        let (near, far) = near_and_far(&parts, [0.0; 3], (FAR_X - 0.5, FAR_X + 0.5), opening);
        assert!((volume(&near) - 0.84).abs() < 1e-4, "near volume {}", volume(&near));
        assert!((volume(&far) - far_volume).abs() < 1e-4, "far volume {}", volume(&far));
    }
}

#[test]
fn issue_6446_mixed_source_parts_are_never_instanced() {
    // #66 / #71 map a near box plus a nested far box; #14 is the far box alone.
    // #14's source (#11) was cached while meshing #66, so its call is a cache
    // hit; the repeated #66 is a second cold walk, since a mixed source is
    // never cached.
    let source = include_str!("../../tests/fixtures/issue_6446_mapped_source_frames.ifc");
    let mut decoder = EntityDecoder::new(source);
    let router = GeometryRouter::new();
    for (id, frames) in [(66, 2), (71, 2), (14, 1), (66, 2)] {
        let item = decoder.decode_by_id(id).unwrap();
        let parts = router.process_mapped_item_parts(&item, &mut decoder).unwrap();
        assert_eq!(parts.len(), frames, "#{id}");
        // One `rep_identity` template cannot carry two frames.
        assert_eq!(parts.iter().filter(|p| p.instance_meta.is_some()).count(), usize::from(frames == 1), "#{id}");
    }
}

#[test]
fn frames_merge_below_the_mapped_origin_limit_only() {
    assert!(frames_mergeable([0.0; 3], [999.9, -999.9, 0.0]));
    assert!(!frames_mergeable([0.0; 3], [0.0, 0.0, 1_000.0]));
    // A NaN origin is already broken input; it keeps the historical merge.
    assert!(frames_mergeable([f64::NAN, 0.0, 0.0], [0.0; 3]));
}

fn bounded(limits: crate::resource::ResourceLimits) -> crate::resource::ExecutionAccount {
    use crate::resource::{ExecutionAccount, ExecutionPolicy};
    ExecutionAccount::new(ExecutionPolicy::Bounded(limits))
}

fn unit_triangle(origin: [f64; 3]) -> Mesh {
    let mut mesh = Mesh::new();
    mesh.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    mesh.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    mesh.indices = vec![0, 1, 2];
    mesh.origin = origin;
    mesh
}

// The real multi-frame fixture must retain source order through the audited
// source-parts materialization, including every triangle buffer.
#[test]
fn resource_source_parts_materialization_preserves_fixture_order_and_frames() {
    use crate::resource::ResourceLimits;
    let source = include_str!("../../tests/fixtures/issue_6446_mapped_source_frames.ifc");
    let run = || {
        let mut decoder = EntityDecoder::new(source);
        let item = decoder.decode_by_id(66).unwrap();
        GeometryRouter::new().process_mapped_item_parts(&item, &mut decoder).unwrap()
    };
    let expected = run();
    let account = bounded(ResourceLimits::default());
    let actual = account.scope(run);
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(&expected) {
        assert_eq!(actual.positions, expected.positions);
        assert_eq!(actual.normals, expected.normals);
        assert_eq!(actual.indices, expected.indices);
        assert_eq!(actual.origin, expected.origin);
        assert_eq!(actual.local_bounds, expected.local_bounds);
        assert_eq!(actual.rtc_applied, expected.rtc_applied);
    }
    assert!(account.usage().copy_bytes > 0, "the accounted run charged its copies");
}

#[test]
fn resource_zero_allowance_refuses_source_merge_before_any_growth() {
    use crate::resource::ResourceLimits;
    let incoming = unit_triangle([0.0; 3]);
    for limits in [
        ResourceLimits { copy_bytes: Some(0), ..Default::default() },
        ResourceLimits { live_bytes: Some(0), ..Default::default() },
        ResourceLimits { work: Some(0), ..Default::default() },
    ] {
        let account = bounded(limits);
        account.scope(|| {
            let mut source = super::SourceParts::default();
            source.merge(&incoming);
            assert!(source.into_parts().is_err(), "{limits:?}");
        });
        assert_eq!(account.usage().live_bytes, 0, "{limits:?}");
        assert_eq!(account.usage().copy_bytes, 0, "{limits:?}");
    }
}

#[test]
fn resource_far_frame_scan_is_charged_per_candidate() {
    use crate::resource::ResourceLimits;
    let account = bounded(ResourceLimits { work: Some(1_000_000), ..Default::default() });
    account.scope(|| {
        let mut source = super::SourceParts::default();
        source.merge(&unit_triangle([0.0; 3]));
        source.merge(&unit_triangle([5_000_000.0, 0.0, 0.0]));
        let before = account.usage().work;
        source.merge(&unit_triangle([9_000_000.0, 0.0, 0.0]));
        assert!(account.usage().work - before >= 2, "two candidates were visited");
        assert_eq!(source.into_parts().unwrap().len(), 3);
    });
}

#[test]
fn resource_default_source_merge_is_unaccounted_and_unchanged() {
    assert!(!crate::resource::is_active());
    let mut source = super::SourceParts::default();
    source.merge(&unit_triangle([0.0; 3]));
    source.merge(&unit_triangle([0.0; 3]));
    let parts = source.into_parts().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0].indices, vec![0, 1, 2, 3, 4, 5]);
}

#[test]
fn resource_empty_source_materialization_admits_placeholder_header_before_allocation() {
    use crate::resource::ResourceLimits;
    let denied = bounded(ResourceLimits { live_bytes: Some(0), ..Default::default() });
    denied.scope(|| {
        assert!(super::SourceParts::default().into_parts().is_err());
        assert!(denied.check().is_err());
    });
    let accepted = bounded(ResourceLimits::default());
    accepted.scope(|| {
        let parts = super::SourceParts::default().into_parts().unwrap();
        assert_eq!(parts.len(), 1);
        assert!(parts[0].positions.is_empty());
        assert!(accepted.usage().live_bytes >= std::mem::size_of::<Mesh>() as u64);
    });
}

#[test]
fn resource_element_parts_match_default_output_and_refuse_zero_allowances() {
    use crate::resource::{ProgramStop, ResourceLimits};
    let source = fixture("#11,#16,#51", "#33");
    let run = || {
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(20).unwrap();
        rtc_router().process_element_parts(&element, &mut decoder)
    };
    let expected = run().unwrap();
    let accounted = bounded(ResourceLimits::default()).scope(run).unwrap();
    assert_eq!(accounted.len(), expected.len());
    for (a, e) in accounted.iter().zip(&expected) {
        assert_eq!((&a.positions, &a.normals, &a.indices), (&e.positions, &e.normals, &e.indices));
        assert_eq!((a.origin, a.local_bounds), (e.origin, e.local_bounds));
    }
    for limits in [
        ResourceLimits { copy_bytes: Some(0), ..Default::default() },
        ResourceLimits { live_bytes: Some(0), ..Default::default() },
    ] {
        let result = bounded(limits).scope(run);
        assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::ResourceRefused(_)))), "{limits:?}");
    }
}

#[test]
fn resource_zero_output_allowance_refuses_mapped_cache_clone() {
    use crate::resource::{ProgramStop, ResourceLimits};
    let source = include_str!("../../tests/fixtures/issue_6446_mapped_source_frames.ifc");
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(66).unwrap();
    let router = GeometryRouter::new();
    let account = bounded(ResourceLimits { output_bytes: Some(0), ..Default::default() });
    let result = account.scope(|| router.process_mapped_item_parts(&item, &mut decoder));
    assert!(matches!(result, Err(crate::Error::ProgramStopped(ProgramStop::ResourceRefused(_)))));
    assert!(router.mapped_item_cache.borrow().is_empty(), "nothing was cached after the refusal");
}
