// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7779 / #7877, F3b X2: the chain refuses what it cannot read (D30, drift 3.5/3.8/3.10)
//! instead of drawing the element at a fallback position. Every case below
//! resolved to the identity (or a displaced garbage frame) on the base commit.

use super::*;
use ifc_lite_core::EntityDecoder;

fn doc(body: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{body}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// `#1` a 3D frame at (1,0,0), `#2` a 2D frame at (0,5) rotated 90 degrees.
const FRAMES: &str = "#1=IFCAXIS2PLACEMENT3D(#3,$,$);\n#3=IFCCARTESIANPOINT((1.,0.,0.));\n\
#4=IFCCARTESIANPOINT((0.,5.));\n#5=IFCDIRECTION((0.,1.));\n#2=IFCAXIS2PLACEMENT2D(#4,#5);\n";

fn resolve(body: &str, id: u32) -> (PlacementResult<Matrix4<f64>>, u64) {
    let content = doc(&format!("{FRAMES}{body}"));
    let mut decoder = EntityDecoder::new(&content);
    let placement = decoder.decode_by_id(id).expect("placement");
    let result = resolve_chain(&placement, &mut decoder);
    (result, decoder.refused_records())
}

/// §3.5: a 2D RelativePlacement is legal in `IfcLocalPlacement` and is honoured
/// (base: silently the identity, the product sat at the origin).
#[test]
fn a_2d_relative_placement_translates_and_rotates_the_product() {
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT($,#2);\n#11=IFCLOCALPLACEMENT(#10,#1);\n", 11);
    let m = result.expect("2D relative placement");
    assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (0.0, 6.0, 0.0), "root (0,5), then (1,0,0) rotated onto +Y");
    assert_eq!((m[(0, 0)], m[(1, 0)]), (0.0, 1.0), "local X is the 2D RefDirection (0,1)");
    assert_eq!(refused, 0);
}

#[test]
fn a_dollar_relative_placement_is_refused_and_counted() {
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT($,$);\n#11=IFCLOCALPLACEMENT(#10,#1);\n", 11);
    assert!(matches!(result, Err(PlacementError::Missing { at: 10, attr: "RelativePlacement" })), "{result:?}");
    assert_eq!(refused, 1);
}

#[test]
fn a_relative_placement_that_is_not_an_axis_placement_is_refused_and_counted() {
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT($,#3);\n", 10);
    assert!(matches!(result, Err(PlacementError::Unsupported { at: 3, .. })), "{result:?}");
    assert_eq!(refused, 1);
}

#[test]
fn a_placement_rel_to_that_is_not_a_placement_is_refused_and_counted() {
    // Base ended the walk at #1 and returned the leaf's local frame alone.
    let (result, refused) = resolve("#10=IFCLOCALPLACEMENT(#1,#1);\n", 10);
    assert!(matches!(result, Err(PlacementError::Unsupported { at: 1, .. })), "{result:?}");
    assert_eq!(refused, 1);
    let content = doc(&format!("{FRAMES}#10=IFCLOCALPLACEMENT(#1,#1);\n"));
    let mut decoder = EntityDecoder::new(&content);
    let leaf = decoder.decode_by_id(10).unwrap();
    assert!(matches!(chain(&leaf, &mut decoder), Err(PlacementError::Unsupported { at: 1, .. })));
}

/// §3.10: base composed the identity for a linear/grid frame it could not
/// sample, so the element sat at its parent's origin.
#[test]
fn an_unsampleable_linear_or_grid_frame_is_refused_and_counted() {
    for (body, id) in [
        ("#10=IFCLINEARPLACEMENT($,$,$);\n", 10),
        ("#10=IFCLOCALPLACEMENT($,#1);\n#11=IFCLINEARPLACEMENT(#10,$,$);\n", 11),
        ("#10=IFCGRIDPLACEMENT($,$,$);\n", 10),
    ] {
        let (result, refused) = resolve(body, id);
        assert!(matches!(result, Err(PlacementError::Missing { .. })), "{body}: {result:?}");
        assert_eq!(refused, 1, "{body}");
    }
}

/// A refusal is never memoised, and the placements below it that did resolve
/// keep their own (complete) answers, so cold and warm decoders agree.
#[test]
fn a_refusal_poisons_neither_its_ancestors_nor_a_second_asker() {
    let body = "#10=IFCLOCALPLACEMENT($,#1);\n#11=IFCLOCALPLACEMENT(#10,$);\n#12=IFCLOCALPLACEMENT(#11,#1);\n";
    let content = doc(&format!("{FRAMES}{body}"));
    let mut decoder = EntityDecoder::new(&content);
    for id in [12, 12, 11] {
        let node = decoder.decode_by_id(id).unwrap();
        assert!(resolve_chain(&node, &mut decoder).is_err(), "#{id}");
    }
    assert!(decoder.get_placement_transform_cached(11).is_none());
    assert!(decoder.get_placement_transform_cached(12).is_none());
    let root = decoder.decode_by_id(10).unwrap();
    assert_eq!(resolve_chain(&root, &mut decoder).unwrap()[(0, 3)], 1.0);
    assert_eq!(decoder.refused_records(), 1, "one bad record, counted once");
}

/// #7779/#7877: optional means absent, never a present value of the wrong kind.
#[test]
fn typed_present_chain_references_refuse_without_memoising_success() {
    for body in [
        "#10=IFCLOCALPLACEMENT(IFCLABEL('bad'),#1);",
        "#10=IFCLOCALPLACEMENT($,IFCLABEL('bad'));",
        "#10=IFCLOCALPLACEMENT($,#1);#20=IFCWALL('g',$,$,$,$,IFCLABEL('bad'),$,$,$);",
    ] {
        let content = doc(&format!("{FRAMES}{body}"));
        let mut decoder = EntityDecoder::new(&content);
        let id = if body.contains("IFCWALL") { 20 } else { 10 };
        let node = decoder.decode_by_id(id).unwrap();
        for _ in 0..2 {
            let refused = if id == 20 {
                resolve_object_placement(&node, &mut decoder).is_err()
            } else {
                resolve_chain(&node, &mut decoder).is_err()
            };
            assert!(refused, "{body}");
            assert!(decoder.get_placement_transform_cached(id).is_none());
            assert_eq!(decoder.refused_records(), 1, "deduplicated record: {body}");
        }
    }
}

#[test]
fn missing_object_placement_keeps_identity_without_a_refusal_7877() {
    for value in ["$", "*"] {
        let content = doc(&format!("#20=IFCWALL('g',$,$,$,$,{value},$,$,$);"));
        let mut decoder = EntityDecoder::new(&content);
        let product = decoder.decode_by_id(20).unwrap();
        assert!(resolve_object_placement(&product, &mut decoder).unwrap().is_none());
        assert_eq!(decoder.refused_records(), 0);
    }
}

#[test]
fn dimension_specific_axis_readers_refuse_wrong_record_types_7877() {
    let content = doc(FRAMES);
    let mut decoder = EntityDecoder::new(&content);
    let planar = decoder.decode_by_id(2).unwrap();
    let spatial = decoder.decode_by_id(1).unwrap();
    assert!(Axis2Placement::read_3d(&planar, &mut decoder).is_err());
    assert!(Axis2Placement::read_2d(&spatial, &mut decoder).is_err());
    assert_eq!(decoder.refused_records(), 2);
    assert!(Axis2Placement::read(&planar, &mut decoder).unwrap().planar);
    assert!(!Axis2Placement::read(&spatial, &mut decoder).unwrap().planar);
}

const LINEAR: &str = "#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((10.,0.,0.));#32=IFCPOLYLINE((#30,#31));
#33=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(5.),$,$,$,#32);
#34=IFCAXIS2PLACEMENTLINEAR(#33,$,$);
";

#[test]
fn unreadable_authored_linear_frame_never_falls_through_to_sampling_7877() {
    for authored in ["IFCLABEL('bad')", "#3", "#999", "#35"] {
        let body = format!("{FRAMES}{LINEAR}#35=IFCAXIS2PLACEMENT3D($,$,$);#10=IFCLINEARPLACEMENT($,#34,{authored});");
        let content = doc(&body).replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
        let mut decoder = EntityDecoder::new(&content);
        let node = decoder.decode_by_id(10).unwrap();
        assert!(resolve_chain(&node, &mut decoder).is_err(), "{authored}");
        assert!(decoder.get_placement_transform_cached(10).is_none());
    }
    // Anti-vacuity: genuinely absent CartesianPosition still samples to +5 X.
    let content = doc(&format!("{LINEAR}#10=IFCLINEARPLACEMENT($,#34,$);"))
        .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
    let mut decoder = EntityDecoder::new(&content);
    let node = decoder.decode_by_id(10).unwrap();
    assert_eq!(resolve_chain(&node, &mut decoder).unwrap()[(0, 3)], 5.0);
    assert_eq!(decoder.refused_records(), 0);
}

const GRID: &str = "#30=IFCCARTESIANPOINT((0.,0.));
#31=IFCCARTESIANPOINT((10.,0.));#32=IFCPOLYLINE((#30,#31));
#33=IFCGRIDAXIS('U',#32,.T.);#34=IFCCARTESIANPOINT((0.,10.));
#35=IFCPOLYLINE((#30,#34));#36=IFCGRIDAXIS('V',#35,.T.);
#37=IFCVIRTUALGRIDINTERSECTION((#33,#36),(0.,0.));
";

#[test]
fn unreadable_grid_direction_refuses_but_readable_zero_keeps_repair_7877() {
    for (direction, record, valid) in [
        ("$", "", true),
        ("#38", "#38=IFCDIRECTION((0.,0.));", true),
        ("#38", "#38=IFCDIRECTION((0.,1.));", true),
        ("#38", "#38=IFCDIRECTION((IFCREAL(0.),1.));", false),
        ("#38", "#38=IFCDIRECTION((1.));", false),
        ("#38", "#38=IFCDIRECTION((1.E400,0.));", false),
        ("#30", "", false),
        ("IFCLABEL('bad')", "", false),
    ] {
        let content = doc(&format!("{GRID}{record}#10=IFCGRIDPLACEMENT($,#37,{direction});"))
            .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
        let mut decoder = EntityDecoder::new(&content);
        let node = decoder.decode_by_id(10).unwrap();
        let result = resolve_chain(&node, &mut decoder);
        if valid {
            let matrix = result.unwrap();
            let expected = if record.contains("(0.,1.)") { (0., 1.) } else { (1., 0.) };
            assert_eq!((matrix[(0, 0)], matrix[(1, 0)]), expected);
            assert_eq!(decoder.refused_records(), 0);
        } else {
            assert!(result.is_err(), "{direction} {record}");
            assert_eq!(decoder.refused_records(), 1);
            assert!(decoder.get_placement_transform_cached(10).is_none());
        }
    }
}

#[test]
fn unreadable_sampled_linear_fields_refuse_and_count_their_record_7877() {
    for bad_linear in [
        LINEAR.replace("IFCLENGTHMEASURE(5.)", "IFCLABEL('bad')"),
        LINEAR.replace("IFCLENGTHMEASURE(5.),$", "IFCLENGTHMEASURE(5.),IFCLABEL('bad')"),
        LINEAR.replace("IFCAXIS2PLACEMENTLINEAR(#33,$,$)", "IFCAXIS2PLACEMENTLINEAR(#33,IFCLABEL('bad'),$)"),
        LINEAR.replace("IFCAXIS2PLACEMENTLINEAR(#33,$,$)", "IFCAXIS2PLACEMENTLINEAR(#33,#39,$)")
            + "#39=IFCDIRECTION((1.));",
    ] {
        let content = doc(&format!("{bad_linear}#10=IFCLINEARPLACEMENT($,#34,$);"))
            .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
        let mut decoder = EntityDecoder::new(&content);
        let node = decoder.decode_by_id(10).unwrap();
        for _ in 0..2 {
            assert!(resolve_chain(&node, &mut decoder).is_err());
            assert_eq!(decoder.refused_records(), 1, "{bad_linear}");
            assert!(decoder.get_placement_transform_cached(10).is_none());
        }
    }
}

#[test]
fn unreadable_grid_offsets_are_not_replaced_with_zero_7877() {
    let content = doc(&format!("{GRID}#10=IFCGRIDPLACEMENT($,#37,$);"))
        .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))")
        .replace("(0.,0.));\n#10=IFCGRIDPLACEMENT", "(IFCLABEL('bad'),0.));\n#10=IFCGRIDPLACEMENT");
    let mut decoder = EntityDecoder::new(&content);
    let node = decoder.decode_by_id(10).unwrap();
    assert!(resolve_chain(&node, &mut decoder).is_err());
    assert_eq!(decoder.refused_records(), 1);
    assert!(decoder.get_placement_transform_cached(10).is_none());
}

#[test]
fn sampled_frame_execution_stops_are_not_malformed_input_7877() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
    for body in [
        format!("{LINEAR}#10=IFCLINEARPLACEMENT($,#34,$);"),
        format!("{GRID}#10=IFCGRIDPLACEMENT($,#37,$);"),
    ] {
        let content = doc(&body).replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        account.cancel();
        let mut decoder = EntityDecoder::new(&content);
        let node = decoder.decode_by_id(10).unwrap();
        let error = account.scope(|| resolve_chain(&node, &mut decoder)).unwrap_err();
        assert!(matches!(error, PlacementError::ProgramStopped(_)), "{error:?}");
        assert!(matches!(crate::Error::from(error), crate::Error::ProgramStopped(_)));
        assert_eq!(decoder.refused_records(), 0);
        assert!(decoder.get_placement_transform_cached(10).is_none());
        // A separate uncancelled scope/source still resolves the valid input.
        let mut fresh = EntityDecoder::new(&content);
        let node = fresh.decode_by_id(10).unwrap();
        assert!(resolve_chain(&node, &mut fresh).is_ok());
    }
}

#[test]
fn grid_direction_uses_canonical_leaf_source_authority_7877() {
    let content = doc(&format!("{GRID}#38=IFCDIRECTION((0.,1.));#10=IFCGRIDPLACEMENT($,#37,#38);"))
        .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
    let mut donor = EntityDecoder::new("#38=IFCDIRECTION((1.,0.));");
    donor.decode_by_id(38).unwrap();
    let cache = donor.drain_cache();
    let mut decoder = EntityDecoder::new(&content);
    decoder.inject_shared_cache(&cache);
    let node = decoder.decode_by_id(10).unwrap();
    let matrix = resolve_chain(&node, &mut decoder).unwrap();
    assert_eq!((matrix[(0, 0)], matrix[(1, 0)]), (0., 1.), "the raw valid leaf wins contradictory decoded values");
    assert_eq!(decoder.refused_records(), 0);
}

/// #7877: a prior quota refusal remains terminal through real frame sampling.
#[test]
fn sampled_frame_preserves_resource_refusal_without_malformed_or_memo_7877() {
    use crate::resource::{Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
    for body in [
        format!("{LINEAR}#10=IFCLINEARPLACEMENT($,#34,$);"),
        format!("{GRID}#10=IFCGRIDPLACEMENT($,#37,$);"),
    ] {
        let content = doc(&body).replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))");
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            work: Some(0), ..ResourceLimits::default()
        }));
        let mut decoder = EntityDecoder::new(&content);
        let node = decoder.decode_by_id(10).unwrap();
        account.scope(|| {
            let stop = crate::resource::charge(Cost { work: 1, ..Cost::default() }).unwrap_err();
            assert!(matches!(stop, ProgramStop::ResourceRefused(_)));
            let error = resolve_chain(&node, &mut decoder).unwrap_err();
            assert!(matches!(error, PlacementError::ProgramStopped(found) if found == stop), "{error:?}");
            assert!(matches!(crate::Error::from(error), crate::Error::ProgramStopped(found) if found == stop));
        });
        assert_eq!(decoder.refused_records(), 0, "quota refusal is not malformed source");
        assert!(decoder.get_placement_transform_cached(10).is_none());
        let mut fresh = EntityDecoder::new(&content);
        let node = fresh.decode_by_id(10).unwrap();
        assert!(resolve_chain(&node, &mut fresh).is_ok(), "uncapped positive control");
    }
}
