// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #8007 / #7781: reconcile DAG work bounds before consolidating the walker.
use super::*;
use ifc_lite_core::EntityDecoder;

#[derive(Default)]
struct Work {
    events: Vec<(bool, u32)>,
    leaves: Vec<u32>,
    refusals: Vec<(u32, WalkRefusal, usize, Option<u32>)>,
    skip: bool,
}
impl WalkVisitor for Work {
    fn item(&mut self, item: &DecodedEntity, _: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        self.leaves.push(item.id);
        Flow::Continue
    }
    fn enter_map(&mut self, level: &MappedLevel, _: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        self.events.push((true, level.item.id));
        if self.skip { Flow::SkipChildren } else { Flow::Continue }
    }
    fn leave_map(&mut self, level: &MappedLevel) {
        self.events.push((false, level.item.id));
    }
    fn refused(&mut self, at: u32, why: WalkRefusal, ctx: &WalkCtx<'_>) {
        self.refusals.push((at, why, ctx.path.len(), ctx.shape_rep.map(|r| r.id)));
    }
}

fn walk(max_levels: u32) -> RepresentationWalk {
    RepresentationWalk {
        select: Select::Any,
        nested: NestedMaps::Expand { max_depth: 32, max_levels },
    }
}

/// O(width) source whose expansion emits width² leaves. Repeated #300 on
/// sibling paths is intentional: every occurrence contributes geometry.
fn wide_source(width: usize) -> String {
    let occurrences = vec!["#300"; width].join(",");
    let leaves = vec!["#1"; width].join(",");
    format!("#100=IFCREPRESENTATIONMAP($,#200);\
        #200=IFCSHAPEREPRESENTATION($,'Body','Brep',({occurrences}));\
        #300=IFCMAPPEDITEM(#400,$);#400=IFCREPRESENTATIONMAP($,#500);\
        #500=IFCSHAPEREPRESENTATION($,'Body','Brep',({leaves}));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));")
}

#[test]
fn issue_8007_dag_occurrences_pay_again_and_are_preserved_at_exact_allowance() {
    let model = wide_source(8);
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut work = Work::default();
    walk(72).map(&root, &mut decoder, &mut work).unwrap();
    assert_eq!(work.leaves, vec![1; 64]);
    assert_eq!(work.events, [(true, 300), (false, 300)].repeat(8));
    assert!(work.refusals.is_empty());

    let mut work = Work::default();
    walk(71).map(&root, &mut decoder, &mut work).unwrap();
    assert_eq!(work.leaves, vec![1; 56]);
    assert_eq!(work.events, [(true, 300), (false, 300)].repeat(7));
    assert_eq!(work.refusals, [(300, WalkRefusal::Budget { max_levels: 71 }, 0, None)]);
}

#[test]
fn issue_8007_root_list_is_precharged_before_its_first_member_is_decoded() {
    let model = wide_source(8);
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut work = Work::default();
    walk(7).map(&root, &mut decoder, &mut work).unwrap();
    assert!(decoder.get_cached(300).is_none());
    assert!(work.events.is_empty());
    assert!(work.leaves.is_empty());
    assert_eq!(work.refusals, [(200, WalkRefusal::Budget { max_levels: 7 }, 0, Some(200))]);
}

#[test]
fn issue_8007_nested_wide_list_stops_once_and_unwinds_ancestors_in_order() {
    let model = format!("{}#600=IFCMAPPEDITEM(#700,$);\
        #700=IFCREPRESENTATIONMAP($,#800);\
        #800=IFCSHAPEREPRESENTATION($,'Body','Brep',(#900));\
        #900=IFCMAPPEDITEM(#100,$);", wide_source(8));
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(600).unwrap();
    let mut work = Work::default();
    walk(9).mapped_item(&root, &mut decoder, &mut work);
    assert!(decoder.get_cached(1).is_none(), "unadmitted source leaves were decoded");
    assert!(work.leaves.is_empty());
    // Eager pre-entry validation is retained: the refused #300 never enters.
    assert_eq!(work.events, [(true, 600), (true, 900), (false, 900), (false, 600)]);
    assert_eq!(work.refusals, [(300, WalkRefusal::Budget { max_levels: 9 }, 2, None)]);
}

#[test]
fn issue_8007_level_meter_is_independent_of_the_item_member_meter() {
    let model = "#10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#40,#40,#40,#40));\
        #40=IFCMAPPEDITEM(#50,$);#50=IFCREPRESENTATIONMAP($,#60);\
        #60=IFCSHAPEREPRESENTATION($,'Body','Brep',());";
    let mut decoder = EntityDecoder::new(model);
    let root = decoder.decode_by_id(10).unwrap();
    let mut work = Work::default();
    walk(4).mapped_item(&root, &mut decoder, &mut work);
    assert_eq!(work.events, [
        (true, 10), (true, 40), (false, 40), (true, 40), (false, 40),
        (true, 40), (false, 40), (false, 10),
    ]);
    assert_eq!(work.refusals, [(40, WalkRefusal::Budget { max_levels: 4 }, 1, None)]);
    let mut work = Work::default();
    walk(5).mapped_item(&root, &mut decoder, &mut work);
    assert_eq!(work.events.len(), 10);
    assert!(work.refusals.is_empty());
}

#[test]
fn issue_8007_ignored_members_are_charged_before_reference_decoding() {
    let model = "#10=IFCREPRESENTATIONMAP($,#20);\
        #20=IFCSHAPEREPRESENTATION($,'Body','Brep',($,7,#1));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));";
    let mut decoder = EntityDecoder::new(model);
    let root = decoder.decode_by_id(10).unwrap();
    let mut work = Work::default();
    walk(2).map(&root, &mut decoder, &mut work).unwrap();
    assert!(decoder.get_cached(1).is_none());
    assert_eq!(work.refusals, [(20, WalkRefusal::Budget { max_levels: 2 }, 0, Some(20))]);
    let mut work = Work::default();
    walk(3).map(&root, &mut decoder, &mut work).unwrap();
    assert_eq!(work.leaves, [1]);
    assert!(work.refusals.is_empty());
}

#[test]
fn issue_8007_product_representations_share_one_budget_and_reset_between_walks() {
    let model = "#10=IFCWALL('g',$,$,$,$,$,#11,$);\
        #11=IFCPRODUCTDEFINITIONSHAPE($,$,(#20,#21,#22));\
        #20=IFCSHAPEREPRESENTATION($,'Body','Brep',(#1));\
        #21=IFCSHAPEREPRESENTATION($,'Body','Brep',(#2));\
        #22=IFCSHAPEREPRESENTATION($,'Body','Brep',(#3));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));\
        #2=IFCCARTESIANPOINT((1.,0.,0.));\
        #3=IFCCARTESIANPOINT((2.,0.,0.));";
    let mut decoder = EntityDecoder::new(model);
    let root = decoder.decode_by_id(10).unwrap();
    for _ in 0..2 {
        let mut work = Work::default();
        walk(1).product(&root, &mut decoder, &mut work).unwrap();
        assert_eq!(work.leaves, [1]);
        assert!(decoder.get_cached(2).is_none());
        assert!(decoder.get_cached(3).is_none());
        assert_eq!(work.refusals, [(21, WalkRefusal::Budget { max_levels: 1 }, 0, Some(21))]);
    }
}

#[test]
fn issue_8007_old_malformed_classification_and_eager_skip_validation_remain() {
    let model = "#10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#999));";
    let mut decoder = EntityDecoder::new(model);
    let root = decoder.decode_by_id(10).unwrap();
    let mut work = Work { skip: true, ..Work::default() };
    walk(MAX_WALK_LEVELS).mapped_item(&root, &mut decoder, &mut work);
    assert!(work.events.is_empty());
    assert_eq!(work.refusals, [(10, WalkRefusal::Malformed, 0, None)]);
    let map = decoder.decode_by_id(20).unwrap();
    assert!(matches!(walk(MAX_WALK_LEVELS).map(&map, &mut decoder, &mut work), Err(ShapeError::Decode(_))));
}

#[test]
fn issue_8007_depth_and_cycle_refusals_still_precede_budget() {
    let model = "#10=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep',(#10));";
    let mut decoder = EntityDecoder::new(model);
    let root = decoder.decode_by_id(10).unwrap();
    let mut work = Work::default();
    walk(1).mapped_item(&root, &mut decoder, &mut work);
    assert_eq!(work.refusals, [(10, WalkRefusal::Cyclic, 1, None)]);
    let mut work = Work::default();
    RepresentationWalk {
        select: Select::Any, nested: NestedMaps::Expand { max_depth: 0, max_levels: 0 },
    }.mapped_item(&root, &mut decoder, &mut work);
    assert_eq!(work.refusals, [(10, WalkRefusal::TooDeep, 0, None)]);
}

#[test]
fn issue_8007_branching_acyclic_dag_has_a_global_stop_and_a_positive_control() {
    let mut model = String::from("#1=IFCCARTESIANPOINT((0.,0.,0.));");
    for depth in 0..7 {
        let item = 100 + depth * 3;
        let children = if depth == 6 { "#1".to_string() }
            else { format!("#{},#{}", item + 3, item + 3) };
        model.push_str(&format!("#{item}=IFCMAPPEDITEM(#{},$);\
            #{}=IFCREPRESENTATIONMAP($,#{});\
            #{}=IFCSHAPEREPRESENTATION($,'Body','Brep',({children}));",
            item + 1, item + 1, item + 2, item + 2));
    }
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut admitted = Work::default();
    walk(190).mapped_item(&root, &mut decoder, &mut admitted);
    assert_eq!(admitted.leaves, vec![1; 64]);
    assert_eq!(admitted.events.len(), 254); // 127 enter/leave pairs
    assert!(admitted.refusals.is_empty());

    let mut limited = Work::default();
    walk(16).mapped_item(&root, &mut decoder, &mut limited);
    assert!(!limited.leaves.is_empty());
    assert!(limited.leaves.len() < 64);
    assert_eq!(limited.refusals.len(), 1);
    assert!(matches!(limited.refusals[0].1, WalkRefusal::Budget { max_levels: 16 }));
    let mut scopes = Vec::new();
    for (entering, id) in limited.events {
        if entering { scopes.push(id); }
        else { assert_eq!(scopes.pop(), Some(id)); }
    }
    assert!(scopes.is_empty(), "global stop left visitor scopes open");
}

#[test]
fn issue_8007_non_expand_policies_keep_their_original_wide_list_behavior() {
    let model = wide_source(8);
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut chain = Work::default();
    RepresentationWalk { select: Select::Any, nested: NestedMaps::FirstChain { max_depth: 32 } }
        .map(&root, &mut decoder, &mut chain).unwrap();
    assert_eq!(chain.leaves, vec![1; 8]);
    assert_eq!(chain.events, [(true, 300), (false, 300)]);
    assert!(chain.refusals.is_empty());
    let mut leaf = Work::default();
    RepresentationWalk { select: Select::Any, nested: NestedMaps::Leaf }
        .map(&root, &mut decoder, &mut leaf).unwrap();
    assert_eq!(leaf.leaves, vec![300; 8]);
    assert!(leaf.events.is_empty());
    assert!(leaf.refusals.is_empty());
    let mut refuse = Work::default();
    RepresentationWalk { select: Select::Any, nested: NestedMaps::Refuse }
        .map(&root, &mut decoder, &mut refuse).unwrap();
    assert!(refuse.leaves.is_empty());
    assert!(refuse.events.is_empty());
    assert_eq!(refuse.refusals, [(300, WalkRefusal::TooDeep, 0, None)]);
}

#[test]
fn issue_8007_refusal_classes_are_preserved_until_the_new_allowance_is_exhausted() {
    let model = "#10=IFCMAPPEDITEM();#11=IFCMAPPEDITEM(#999,$);\
        #12=IFCMAPPEDITEM(#20,$);#20=IFCREPRESENTATIONMAP($);\
        #13=IFCMAPPEDITEM(#21,$);#21=IFCREPRESENTATIONMAP($,#30);\
        #30=IFCSHAPEREPRESENTATION($,'Body','Brep');\
        #14=IFCMAPPEDITEM(#22,$);#22=IFCREPRESENTATIONMAP($,#31);\
        #31=IFCSHAPEREPRESENTATION($,'Body','Brep',7);";
    let mut decoder = EntityDecoder::new(model);
    for (id, why) in [(10, WalkRefusal::Dangling), (11, WalkRefusal::Dangling),
        (12, WalkRefusal::Malformed), (13, WalkRefusal::Malformed), (14, WalkRefusal::Malformed)] {
        let item = decoder.decode_by_id(id).unwrap();
        let mut work = Work::default();
        walk(1).mapped_item(&item, &mut decoder, &mut work);
        assert!(work.events.is_empty());
        assert_eq!(work.refusals, [(id, why, 0, None)]);
        let mut work = Work::default();
        walk(0).mapped_item(&item, &mut decoder, &mut work);
        assert_eq!(work.refusals, [(id, WalkRefusal::Budget { max_levels: 0 }, 0, None)]);
    }
}
