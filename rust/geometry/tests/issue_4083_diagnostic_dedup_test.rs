// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #4083 (double-count half, separable subset of the still-open determinism
//! issue): the over-collapse control the fix must NOT trip.
//!
//! `issue_4067_diagnostic_cache_repro.rs`'s
//! `barrier_controlled_concurrent_miss_does_not_double_count` proves two
//! racing MISSES of the SAME structural item collapse to one diagnostic. That
//! alone does not prove the collapse is scoped to `item_dedup_key` rather
//! than, say, "the second CSG failure recorded against a shared cache is
//! always dropped" — a bug that would silently undercount two REAL,
//! independent defects on two different elements. This file is that check:
//! two structurally DISTINCT open-topology unions, sharing one
//! `ItemDedupCache`, must both be counted.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{BoolFailureReason, GeometryRouter, ItemDedupCache};

/// `IfcWall` #10, Body item #170 = `IFCBOOLEANRESULT(.UNION., #150, #164)`:
/// open-topology union at box offset (0.5,0.5,0.5) — identical fixture to
/// `issue_4067_diagnostic_cache_repro.rs`'s `WALL_WITH_OPEN_UNION`.
const WALL_A: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('4083 open-topology union A'),'2;1');
FILE_NAME('a.ifc','2026-09-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6f',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1OpenTopologyUnionWallA1',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#170));
#100=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCCARTESIANPOINT((1.,0.,0.));
#102=IFCCARTESIANPOINT((1.,1.,0.));
#103=IFCCARTESIANPOINT((0.,1.,0.));
#104=IFCCARTESIANPOINT((0.,0.,1.));
#105=IFCCARTESIANPOINT((1.,0.,1.));
#106=IFCCARTESIANPOINT((1.,1.,1.));
#107=IFCCARTESIANPOINT((0.,1.,1.));
#110=IFCPOLYLOOP((#100,#103,#102,#101));
#111=IFCPOLYLOOP((#100,#101,#105,#104));
#112=IFCPOLYLOOP((#101,#102,#106,#105));
#113=IFCPOLYLOOP((#102,#103,#107,#106));
#114=IFCPOLYLOOP((#103,#100,#104,#107));
#120=IFCFACEOUTERBOUND(#110,.T.);
#121=IFCFACEOUTERBOUND(#111,.T.);
#122=IFCFACEOUTERBOUND(#112,.T.);
#123=IFCFACEOUTERBOUND(#113,.T.);
#124=IFCFACEOUTERBOUND(#114,.T.);
#130=IFCFACE((#120));
#131=IFCFACE((#121));
#132=IFCFACE((#122));
#133=IFCFACE((#123));
#134=IFCFACE((#124));
#140=IFCCLOSEDSHELL((#130,#131,#132,#133,#134));
#150=IFCFACETEDBREP(#140);
#161=IFCCARTESIANPOINT((0.5,0.5,0.5));
#160=IFCAXIS2PLACEMENT3D(#161,$,$);
#162=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,1.0);
#163=IFCDIRECTION((0.,0.,1.));
#164=IFCEXTRUDEDAREASOLID(#162,#160,#163,1.0);
#170=IFCBOOLEANRESULT(.UNION.,#150,#164);
ENDSEC;
END-ISO-10303-21;
"#;

/// Same shape family as `WALL_A`, but the overlapping box is offset to
/// (0.35,0.35,0.55) instead of (0.5,0.5,0.5) — a structurally DIFFERENT
/// union (different vertex coordinates baked into `item_dedup_key`'s
/// structural hash), still an open-topology tear against the same
/// missing-top-face cube. This is a second, independent structural item, not
/// the same one re-parsed: its `item_dedup_key` must differ from `WALL_A`'s.
const WALL_B: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('4083 open-topology union B'),'2;1');
FILE_NAME('b.ifc','2026-09-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6g',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1OpenTopologyUnionWallB1',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#170));
#100=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCCARTESIANPOINT((1.,0.,0.));
#102=IFCCARTESIANPOINT((1.,1.,0.));
#103=IFCCARTESIANPOINT((0.,1.,0.));
#104=IFCCARTESIANPOINT((0.,0.,1.));
#105=IFCCARTESIANPOINT((1.,0.,1.));
#106=IFCCARTESIANPOINT((1.,1.,1.));
#107=IFCCARTESIANPOINT((0.,1.,1.));
#110=IFCPOLYLOOP((#100,#103,#102,#101));
#111=IFCPOLYLOOP((#100,#101,#105,#104));
#112=IFCPOLYLOOP((#101,#102,#106,#105));
#113=IFCPOLYLOOP((#102,#103,#107,#106));
#114=IFCPOLYLOOP((#103,#100,#104,#107));
#120=IFCFACEOUTERBOUND(#110,.T.);
#121=IFCFACEOUTERBOUND(#111,.T.);
#122=IFCFACEOUTERBOUND(#112,.T.);
#123=IFCFACEOUTERBOUND(#113,.T.);
#124=IFCFACEOUTERBOUND(#114,.T.);
#130=IFCFACE((#120));
#131=IFCFACE((#121));
#132=IFCFACE((#122));
#133=IFCFACE((#123));
#134=IFCFACE((#124));
#140=IFCCLOSEDSHELL((#130,#131,#132,#133,#134));
#150=IFCFACETEDBREP(#140);
#161=IFCCARTESIANPOINT((0.35,0.35,0.55));
#160=IFCAXIS2PLACEMENT3D(#161,$,$);
#162=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,1.0);
#163=IFCDIRECTION((0.,0.,1.));
#164=IFCEXTRUDEDAREASOLID(#162,#160,#163,1.0);
#170=IFCBOOLEANRESULT(.UNION.,#150,#164);
ENDSEC;
END-ISO-10303-21;
"#;

fn wall_entity(decoder: &mut EntityDecoder) -> ifc_lite_core::DecodedEntity {
    decoder.decode_by_id(10).expect("decode #10 IfcWall")
}

fn fresh_decoder(content: &'static str) -> EntityDecoder<'static> {
    let index = ifc_lite_core::build_entity_index(content.as_bytes());
    EntityDecoder::with_index(content.as_bytes(), index)
}

fn kernel_error_count(router: &GeometryRouter) -> usize {
    router
        .take_csg_failures()
        .values()
        .flatten()
        .filter(|f| matches!(f.reason, BoolFailureReason::KernelError(_)))
        .count()
}

/// Two structurally DISTINCT open-topology unions, sharing ONE
/// `ItemDedupCache`, must both record their own `KernelError` — the #4083
/// double-count fix's per-`item_dedup_key` claim must not conflate them just
/// because they share a cache. If this collapsed to 1 the fix would be
/// undercounting real, independent defects, which #4083's brief calls out as
/// worse than the double-count bug itself.
#[test]
fn distinct_structural_items_sharing_a_cache_both_count() {
    let shared: ItemDedupCache = GeometryRouter::new_dedup_cache();

    let mut decoder_a = fresh_decoder(WALL_A);
    let mut router_a = GeometryRouter::with_units(WALL_A.as_bytes(), &mut decoder_a);
    router_a.enable_content_dedup_shared(shared.clone());
    let entity_a = wall_entity(&mut decoder_a);
    let mesh_a = router_a
        .process_element(&entity_a, &mut decoder_a)
        .expect("mesh wall A");
    assert!(!mesh_a.positions.is_empty());
    let count_a = kernel_error_count(&router_a);

    let mut decoder_b = fresh_decoder(WALL_B);
    let mut router_b = GeometryRouter::with_units(WALL_B.as_bytes(), &mut decoder_b);
    router_b.enable_content_dedup_shared(shared.clone());
    let entity_b = wall_entity(&mut decoder_b);
    let mesh_b = router_b
        .process_element(&entity_b, &mut decoder_b)
        .expect("mesh wall B");
    assert!(!mesh_b.positions.is_empty());
    let count_b = kernel_error_count(&router_b);

    assert_eq!(
        (count_a, count_b),
        (1, 1),
        "two structurally distinct open-topology unions sharing one ItemDedupCache must both \
         be counted (got A={count_a}, B={count_b}); a collapse to (1,0) or (0,1) would mean the \
         #4083 fix is suppressing a genuinely different operation's diagnostic, not a duplicate \
         of the same one"
    );
}
