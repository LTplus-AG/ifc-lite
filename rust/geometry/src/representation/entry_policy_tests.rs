// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8007/#7781: explicit Class X entry/refusal policy before Class R.
use super::*;

#[derive(Default)]
struct Trace {
    events: Vec<String>,
    refusals: Vec<(u32, WalkRefusal)>,
    answer: Option<Flow>,
    answer_at: Option<u32>,
    replace_decoder: bool,
}

impl WalkVisitor for Trace {
    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        self.events.push(format!("item {} {:?} depth {}", item.id, item.ifc_type, at.path.len()));
        Flow::Continue
    }
    fn enter_map(&mut self, level: &MappedLevel, at: &WalkCtx<'_>, d: &mut EntityDecoder) -> Flow {
        self.events.push(format!("enter {} depth {}", level.item.id, at.path.len()));
        if self.replace_decoder {
            // Public &mut EntityDecoder permits replacement. The level itself
            // remains the pre-callback snapshot; its child resolves afterwards.
            *d = EntityDecoder::new(REPLACEMENT);
        }
        if self.answer_at.is_none_or(|id| id == level.item.id) {
            self.answer.unwrap_or(Flow::Continue)
        } else { Flow::Continue }
    }
    fn leave_map(&mut self, level: &MappedLevel) {
        self.events.push(format!("leave {}", level.item.id));
    }
    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, at: &WalkCtx<'_>) {
        self.events.push(format!("refuse {} depth {} shape {:?}",
            item.id, at.path.len(), at.shape_rep.map(|r| r.id)));
        self.refusals.push((item.id, why));
    }
}

fn walk(max_levels: u32) -> RepresentationWalk {
    RepresentationWalk { select: Select::Any,
        nested: NestedMaps::Expand { max_depth: 32, max_levels } }
}

const REPLACEMENT: &str = "#1=IFCDIRECTION((1.,0.,0.));\
    #2=IFCCARTESIANPOINT((2.,0.,0.));\
    #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#2));";

#[test]
fn issue_8007_items_failure_is_inside_entry_and_siblings_survive() {
    for (items, class) in [("", "missing"), (",7", "decode"), (",(#999)", "decode")] {
        let model = format!("#10=IFCREPRESENTATIONMAP($,#11);\
            #11=IFCSHAPEREPRESENTATION($,'Body','Brep',(#20,#1,#20));\
            #20=IFCMAPPEDITEM(#21,$);#21=IFCREPRESENTATIONMAP($,#30);\
            #30=IFCSHAPEREPRESENTATION($,'Body','Brep'{items});\
            #1=IFCCARTESIANPOINT((0.,0.,0.));");
        let mut d = EntityDecoder::new(&model);
        let root = d.decode_by_id(10).unwrap();
        let mut trace = Trace::default();
        walk(10).map(&root, &mut d, &mut trace).unwrap();
        assert_eq!(trace.events, ["enter 20 depth 0", "refuse 20 depth 0 shape None",
            "leave 20", "item 1 IfcCartesianPoint depth 0", "enter 20 depth 0",
            "refuse 20 depth 0 shape None", "leave 20"]);
        assert_eq!(trace.refusals.len(), 2);
        for (id, why) in trace.refusals {
            assert_eq!(id, 20);
            match (class, why) {
                ("missing", WalkRefusal::MissingItems) | ("decode", WalkRefusal::Decode(_)) => {}
                (_, why) => panic!("wrong refusal: {why:?}"),
            }
        }
    }
}

#[test]
fn issue_8007_root_items_errors_still_return_shape_error_without_entry() {
    for (items, missing) in [("", true), (",7", false), (",(#999)", false)] {
        let model = format!("#20=IFCREPRESENTATIONMAP($,#30);\
            #30=IFCSHAPEREPRESENTATION($,'Body','Brep'{items});");
        let mut d = EntityDecoder::new(&model);
        let root = d.decode_by_id(20).unwrap();
        let mut trace = Trace::default();
        let error = walk(1).map(&root, &mut d, &mut trace).unwrap_err();
        assert!(matches!((missing, error),
            (true, ShapeError::MissingItems) | (false, ShapeError::Decode(_))));
        assert!(trace.events.is_empty());
        assert!(trace.refusals.is_empty());
    }
}

#[test]
fn issue_8007_skip_and_stop_suppress_only_post_entry_items_work() {
    // Missing Items, bad list, unresolved child, and a valid over-budget list.
    for items in ["", ",7", ",(#999)", ",(#1,#1)"] {
        for answer in [Flow::SkipChildren, Flow::Stop] {
            let model = format!("#10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
                #30=IFCSHAPEREPRESENTATION($,'Body','Brep'{items});\
                #1=IFCCARTESIANPOINT((0.,0.,0.));");
            let mut d = EntityDecoder::new(&model);
            let root = d.decode_by_id(10).unwrap();
            let mut trace = Trace { answer: Some(answer), ..Trace::default() };
            walk(1).mapped_item(&root, &mut d, &mut trace);
            assert_eq!(trace.events, ["enter 10 depth 0", "leave 10"]);
            assert!(trace.refusals.is_empty());
            assert!(d.get_cached(1).is_none());
            // Level admission still precedes either visitor answer.
            let mut denied = Trace { answer: Some(answer), ..Trace::default() };
            walk(0).mapped_item(&root, &mut d, &mut denied);
            assert_eq!(denied.events, ["refuse 10 depth 0 shape None"]);
            assert!(matches!(denied.refusals[0].1, WalkRefusal::Budget { max_levels: 0 }));
        }
    }
}

#[test]
fn issue_8007_skip_saves_items_allowance_but_stop_ends_siblings() {
    let model = "#10=IFCREPRESENTATIONMAP($,#11);\
        #11=IFCSHAPEREPRESENTATION($,'Body','Brep',(#20,#1));\
        #20=IFCMAPPEDITEM(#21,$);#21=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#999,#999,#999));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));";
    for answer in [Flow::SkipChildren, Flow::Stop] {
        let mut d = EntityDecoder::new(model);
        let root = d.decode_by_id(10).unwrap();
        let mut trace = Trace { answer: Some(answer), ..Trace::default() };
        walk(2).map(&root, &mut d, &mut trace).unwrap();
        let mut expected = vec!["enter 20 depth 0", "leave 20"];
        if answer == Flow::SkipChildren { expected.push("item 1 IfcCartesianPoint depth 0"); }
        assert_eq!(trace.events, expected);
        assert!(trace.refusals.is_empty());
    }
}

#[test]
fn issue_8007_nested_overbudget_items_report_once_before_decode_and_unwind() {
    let model = "#10=IFCMAPPEDITEM(#11,$);#11=IFCREPRESENTATIONMAP($,#12);\
        #12=IFCSHAPEREPRESENTATION($,'Body','Brep',(#20,#1));\
        #20=IFCMAPPEDITEM(#21,$);#21=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#999));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));";
    let mut d = EntityDecoder::new(model);
    let root = d.decode_by_id(10).unwrap();
    let mut trace = Trace::default();
    walk(2).mapped_item(&root, &mut d, &mut trace);
    assert_eq!(trace.events, ["enter 10 depth 0", "enter 20 depth 1",
        "refuse 20 depth 1 shape None", "leave 20", "leave 10"]);
    assert_eq!(trace.refusals.len(), 1);
    assert!(matches!(trace.refusals[0], (20, WalkRefusal::Budget { max_levels: 2 })));
    // Root list was already fully decoded; #1 is cached but never visited.
    assert!(d.get_cached(1).is_some());
}

#[test]
fn issue_8007_nested_entry_stop_unwinds_without_decoding_its_items() {
    let model = "#10=IFCMAPPEDITEM(#11,$);#11=IFCREPRESENTATIONMAP($,#12);\
        #12=IFCSHAPEREPRESENTATION($,'Body','Brep',(#20,#1));\
        #20=IFCMAPPEDITEM(#21,$);#21=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#999));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));";
    let mut d = EntityDecoder::new(model);
    let root = d.decode_by_id(10).unwrap();
    let mut trace = Trace { answer: Some(Flow::Stop), answer_at: Some(20), ..Trace::default() };
    walk(10).mapped_item(&root, &mut d, &mut trace);
    assert_eq!(trace.events, ["enter 10 depth 0", "enter 20 depth 1", "leave 20", "leave 10"]);
    assert!(trace.refusals.is_empty());
}

#[test]
fn issue_8007_entry_decoder_mutation_affects_children_but_not_level_snapshot() {
    let model = "#10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#1));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));";
    let mut d = EntityDecoder::new(model);
    let root = d.decode_by_id(10).unwrap();
    let mut trace = Trace { replace_decoder: true, ..Trace::default() };
    walk(1).mapped_item(&root, &mut d, &mut trace);
    assert_eq!(trace.events, ["enter 10 depth 0", "item 1 IfcDirection depth 1", "leave 10"]);
    assert!(trace.refusals.is_empty());
    assert!(d.get_cached(2).is_none(), "must not re-resolve the level snapshot");
}

#[test]
fn issue_8007_typed_refusals_preserve_missing_unresolved_and_decode_distinctions() {
    let model = "#10=IFCMAPPEDITEM();#11=IFCMAPPEDITEM($,$);#12=IFCMAPPEDITEM(#999,$);\
        #13=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($);\
        #14=IFCMAPPEDITEM(#21,$);#21=IFCREPRESENTATIONMAP($,$);\
        #15=IFCMAPPEDITEM(#22,$);#22=IFCREPRESENTATIONMAP($,#999);\
        #16=IFCMAPPEDITEM(#23,$);#23=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep');\
        #17=IFCMAPPEDITEM(#24,$);#24=IFCREPRESENTATIONMAP($,#31);\
        #31=IFCSHAPEREPRESENTATION($,'Body','Brep',7);";
    let mut d = EntityDecoder::new(model);
    for id in 10..=17 {
        let root = d.decode_by_id(id).unwrap();
        let mut trace = Trace::default();
        walk(1).mapped_item(&root, &mut d, &mut trace);
        assert_eq!(trace.refusals.len(), 1);
        let (at, why) = trace.refusals.pop().unwrap();
        assert_eq!(at, id);
        assert!(matches!((id, &why),
            (10, WalkRefusal::MissingSource) | (11, WalkRefusal::UnresolvedSource)
            | (12 | 15 | 17, WalkRefusal::Decode(_))
            | (13, WalkRefusal::MissingMappedRepresentation)
            | (14, WalkRefusal::UnresolvedMappedRepresentation) | (16, WalkRefusal::MissingItems)));
        if id < 16 {
            assert_eq!(trace.events, [format!("refuse {id} depth 0 shape None")]);
        } else {
            assert_eq!(trace.events, [format!("enter {id} depth 0"),
                format!("refuse {id} depth 0 shape None"), format!("leave {id}")]);
        }
        let expected = match id {
            10 => "Geometry processing error: MappedItem missing MappingSource".to_string(),
            11 => "Geometry processing error: Failed to resolve MappingSource".to_string(),
            13 => "Geometry processing error: RepresentationMap missing MappedRepresentation".to_string(),
            14 => "Geometry processing error: Failed to resolve MappedRepresentation".to_string(),
            16 => "Geometry processing error: Representation missing Items".to_string(),
            _ => {
                let error = if id == 17 { d.resolve_ref_list(&ifc_lite_core::AttributeValue::Integer(7)).unwrap_err() }
                    else { d.decode_by_id(999).unwrap_err() };
                crate::Error::CoreError(error).to_string()
            }
        };
        assert_eq!(why.into_error(id).to_string(), expected);
    }
    for (why, text) in [
        (WalkRefusal::Cyclic, "Detected cyclic IfcMappedItem reference at #42"),
        (WalkRefusal::TooDeep { max_depth: 3 }, "MappedItem nesting exceeded maximum depth of 3 at #42"),
        (WalkRefusal::Budget { max_levels: 2 }, "IfcMappedItem expansion exceeded the work budget of 2 levels or item references at #42"),
    ] {
        assert_eq!(why.into_error(42).to_string(), format!("Geometry processing error: {text}"));
    }
}


#[test]
fn issue_8020_wrong_class_mapping_targets_refuse_without_owner_assertions() {
    for nested in [NestedMaps::Expand { max_depth: 32, max_levels: 10 },
        NestedMaps::FirstChain { max_depth: 32 }] {
        for (source, missing_map_rep) in [
            ("#20=IFCCARTESIANPOINT((0.,0.,0.));", true),
            ("#20=IFCREPRESENTATIONMAP($,#30);#30=IFCCARTESIANPOINT((0.,0.,0.));", false),
        ] {
            let model = format!("#10=IFCMAPPEDITEM(#20,$);{source}");
            let mut decoder = EntityDecoder::new(&model);
            let root = decoder.decode_by_id(10).unwrap();
            let mut trace = Trace::default();
            RepresentationWalk { select: Select::Any, nested }
                .mapped_item(&root, &mut decoder, &mut trace);
            assert_eq!(trace.refusals.len(), 1);
            assert_eq!(trace.refusals[0].0, 10);
            if missing_map_rep {
                assert!(matches!(&trace.refusals[0].1, WalkRefusal::MissingMappedRepresentation));
                assert_eq!(trace.events, ["refuse 10 depth 0 shape None"]);
            } else {
                assert!(matches!(&trace.refusals[0].1, WalkRefusal::MissingItems));
                assert_eq!(trace.events, ["enter 10 depth 0",
                    "refuse 10 depth 0 shape None", "leave 10"]);
            }
        }
    }
}

#[test]
fn issue_8020_wrong_class_root_map_and_representation_keep_shape_errors() {
    for model in ["#20=IFCCARTESIANPOINT((0.,0.,0.));",
        "#20=IFCREPRESENTATIONMAP($,#30);#30=IFCCARTESIANPOINT((0.,0.,0.));"] {
        let mut decoder = EntityDecoder::new(model);
        let root = decoder.decode_by_id(20).unwrap();
        let mut trace = Trace::default();
        let result = walk(10).map(&root, &mut decoder, &mut trace);
        assert!(matches!(result, Err(ShapeError::MissingItems)));
        assert!(trace.events.is_empty());
    }
}
