// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The representation home on small STEP fixtures: shape errors keep their
//! text, `Select` policies pick the lists they name, and the walk visits in
//! DFS pre-order under each nesting policy with a depth cap and a path-scoped
//! visited set.

use super::*;
use ifc_lite_core::EntityDecoder;

/// A wall with a direct Body, a MappedRepresentation duplicate of it, an
/// Axis curve and a Surface3D; plus map #60 over rep #61 (items #70, mapped #71
/// into map #62 over rep #63 holding item #72), a DAG reuse (#73 re-enters #60)
/// and a cycle (#80 -> map #81 -> rep #82 -> #80).
const MODEL: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));\
    #10=IFCWALL('g',$,$,$,$,$,#11,$);\
    #11=IFCPRODUCTDEFINITIONSHAPE($,$,(#20,#21,#22,#23));\
    #20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#1));\
    #21=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#30));\
    #22=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#1));\
    #23=IFCSHAPEREPRESENTATION($,'Body','Surface3D',(#1));\
    #30=IFCMAPPEDITEM(#60,$);\
    #60=IFCREPRESENTATIONMAP($,#61);#61=IFCSHAPEREPRESENTATION($,'Body','Brep',(#70,#71,#73));\
    #70=IFCCARTESIANPOINT((1.,0.,0.));#71=IFCMAPPEDITEM(#62,$);\
    #62=IFCREPRESENTATIONMAP($,#63);#63=IFCSHAPEREPRESENTATION($,'Body','Brep',(#72));\
    #72=IFCCARTESIANPOINT((2.,0.,0.));\
    #73=IFCMAPPEDITEM(#62,$);\
    #80=IFCMAPPEDITEM(#81,$);#81=IFCREPRESENTATIONMAP($,#82);\
    #82=IFCSHAPEREPRESENTATION($,'Body','Brep',(#80));\
    #100=IFCMAPPEDITEM($,$);#101=IFCMAPPEDITEM(#102,$);#102=IFCREPRESENTATIONMAP($,$);\
    #103=IFCMAPPEDITEM(#104,$);#104=IFCREPRESENTATIONMAP($,#105);#105=IFCSHAPEREPRESENTATION($,'Body','Brep',$);\
    #90=IFCOPENINGELEMENT('g',$,$,$,$,$,#91,$);#91=IFCPRODUCTDEFINITIONSHAPE($,$,());\
    #95=IFCWALL('g',$,$,$,$,$,$,$);#96=IFCWALL('g',$,$,$,$,$,#1,$);";

#[derive(Default)]
struct Trace {
    events: Vec<String>,
    refused: Vec<(u32, String)>,
    stop_at: Option<u32>,
}

impl WalkVisitor for Trace {
    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, _d: &mut EntityDecoder) -> Flow {
        self.events.push(format!("item {} depth {}", item.id, at.path.len()));
        if self.stop_at == Some(item.id) { Flow::Stop } else { Flow::Continue }
    }
    fn enter_map(&mut self, l: &MappedLevel, _at: &WalkCtx<'_>, _d: &mut EntityDecoder) -> Flow {
        self.events.push(format!("enter {} map {}", l.item.id, l.map.id));
        Flow::Continue
    }
    fn leave_map(&mut self, l: &MappedLevel) {
        self.events.push(format!("leave {}", l.item.id));
    }
    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, _ctx: &WalkCtx<'_>) {
        self.refused.push((item.id, why.into_error(item.id).to_string()));
    }
}

fn ids(it: impl Iterator<Item = impl std::borrow::Borrow<DecodedEntity>>) -> Vec<u32> {
    it.map(|e| e.borrow().id).collect()
}

#[test]
fn product_shape_errors_keep_their_text() {
    let mut d = EntityDecoder::new(MODEL);
    let wall_95 = d.decode_by_id(95).unwrap();
    assert!(matches!(product_shape(&wall_95, &mut d), Ok(None)));
    let wall_96 = d.decode_by_id(96).unwrap();
    assert_eq!(
        product_shape(&wall_96, &mut d).err().map(|e| crate::Error::from(e).to_string()).as_deref(),
        Some("Geometry processing error: Expected IfcProductDefinitionShape, got IfcCartesianPoint")
    );
    let shape = { let e = d.decode_by_id(10).unwrap(); product_shape(&e, &mut d).unwrap().unwrap() };
    assert_eq!((shape.id, shape.representations().len()), (11, 4));
    let rep = d.decode_by_id(11).unwrap();
    assert_eq!(
        rep_items(&rep, &mut d).err().map(|e| crate::Error::from(e).to_string()).as_deref(),
        Some("Geometry processing error: IfcShapeRepresentation missing Items")
    );
}

#[test]
fn select_names_its_list() {
    let mut d = EntityDecoder::new(MODEL);
    let wall = d.decode_by_id(10).unwrap();
    let shape = product_shape(&wall, &mut d).unwrap().unwrap();
    // The mapped duplicate is not rendered while direct geometry carries the body.
    assert_eq!(ids(shape.select(&wall, Select::Meshed)), [20, 23]);
    assert_eq!(ids(shape.select(&wall, Select::Body)), [20, 21, 23]);
    // Surface3D is meshable but not RTC-votable.
    assert_eq!(ids(shape.select(&wall, Select::RtcVotable)), [20, 21]);
    assert_eq!(ids(shape.select(&wall, Select::Any)), [20, 21, 22, 23]);
    fn axis(_: &DecodedEntity, _: &DecodedEntity, ty: Option<&str>) -> bool {
        ty == Some("Curve3D")
    }
    assert_eq!(ids(shape.select(&wall, Select::Where(axis))), [22]);
    assert_eq!(ids(meshed_representations(&wall, shape.representations())), [20, 23]);
}

#[test]
fn expand_visits_in_preorder_with_a_path_scoped_set() {
    let mut d = EntityDecoder::new(MODEL);
    let wall = d.decode_by_id(10).unwrap();
    let mut trace = Trace::default();
    let walk = RepresentationWalk { select: Select::Body, nested: NestedMaps::Expand { max_depth: 32 } };
    walk.product(&wall, &mut d, &mut trace).unwrap();
    // #71 and #73 both re-enter map #62: a DAG, not a cycle.
    let expected = [
        "item 1 depth 0",
        "enter 30 map 60",
        "item 70 depth 1",
        "enter 71 map 62",
        "item 72 depth 2",
        "leave 71",
        "enter 73 map 62",
        "item 72 depth 2",
        "leave 73",
        "leave 30",
        "item 1 depth 0",
    ];
    assert_eq!(trace.events, expected);
    assert!(trace.refused.is_empty());
}

#[test]
fn expand_refuses_a_cycle_and_the_depth_cap() {
    let mut d = EntityDecoder::new(MODEL);
    let cycle = d.decode_by_id(80).unwrap();
    let walk = RepresentationWalk { select: Select::Any, nested: NestedMaps::Expand { max_depth: 32 } };
    let mut trace = Trace::default();
    walk.mapped_item(&cycle, &mut d, &mut trace);
    assert_eq!(
        trace.refused,
        [(80, "Geometry processing error: Detected cyclic IfcMappedItem reference at #80".to_string())]
    );

    let nested = d.decode_by_id(30).unwrap();
    let shallow = RepresentationWalk { select: Select::Any, nested: NestedMaps::Expand { max_depth: 1 } };
    let mut trace = Trace::default();
    shallow.mapped_item(&nested, &mut d, &mut trace);
    let deep = |id: u32| (id, "Geometry processing error: MappedItem nesting exceeded maximum depth of 1 at #".to_string() + &id.to_string());
    assert_eq!(trace.refused, [deep(71), deep(73)]);
}

#[test]
fn first_chain_never_branches_and_stop_ends_the_walk() {
    let mut d = EntityDecoder::new(MODEL);
    let nested = d.decode_by_id(30).unwrap();
    let chain = RepresentationWalk { select: Select::Any, nested: NestedMaps::FirstChain { max_depth: 32 } };
    let mut trace = Trace::default();
    chain.mapped_item(&nested, &mut d, &mut trace);
    // The level's own items first, then only the first mapped item (#71, not #73).
    assert_eq!(
        trace.events,
        ["enter 30 map 60", "item 70 depth 1", "enter 71 map 62", "item 72 depth 2", "leave 71", "leave 30"]
    );

    let mut stopped = Trace { stop_at: Some(70), ..Trace::default() };
    chain.mapped_item(&nested, &mut d, &mut stopped);
    assert_eq!(stopped.events, ["enter 30 map 60", "item 70 depth 1", "leave 30"]);
}

#[test]
fn refuse_stops_at_a_nested_map_and_leaf_hands_it_over() {
    let mut d = EntityDecoder::new(MODEL);
    let map = d.decode_by_id(60).unwrap();
    let refuse = RepresentationWalk { select: Select::Any, nested: NestedMaps::Refuse };
    let mut trace = Trace::default();
    refuse.map(&map, &mut d, &mut trace).unwrap();
    assert_eq!(trace.events, ["item 70 depth 0"]);
    assert_eq!(trace.refused.len(), 1);
    assert!(trace.refused[0].1.contains("exceeded maximum depth of 0 at #71"));

    let leaf = RepresentationWalk { select: Select::Any, nested: NestedMaps::Leaf };
    let mut trace = Trace::default();
    leaf.map(&map, &mut d, &mut trace).unwrap();
    assert_eq!(trace.events, ["item 70 depth 0", "item 71 depth 0", "item 73 depth 0"]);
}

#[test]
fn refusals_carry_the_strict_walks_message_text() {
    let mut d = EntityDecoder::new(MODEL);
    let walk = RepresentationWalk { select: Select::Any, nested: NestedMaps::Expand { max_depth: 32 } };
    for (id, text) in [
        (100, "Failed to resolve MappingSource"),
        (101, "Failed to resolve MappedRepresentation"),
        (103, "Representation missing Items"),
    ] {
        let item = d.decode_by_id(id).unwrap();
        let mut trace = Trace::default();
        walk.mapped_item(&item, &mut d, &mut trace);
        // Only a refusal of the level's own items comes after `enter_map`.
        let entered = if id == 103 { vec!["enter 103 map 104".to_string(), "leave 103".to_string()] } else { vec![] };
        assert_eq!(trace.events, entered, "#{id}");
        assert_eq!(trace.refused.len(), 1, "#{id}");
        assert!(trace.refused[0].1.ends_with(text), "#{id}: {}", trace.refused[0].1);
    }
}
