// SPDX-License-Identifier: MPL-2.0
//! Tests for `empty.rs`, split out under the house pattern (AGENTS.md): the
//! production module stays under the module-size ratchet, and this file is
//! exempt via the `_tests.rs` suffix.
//!
//! The end-to-end behaviour (what a merged file does and does not contain) is
//! asserted in `tests.rs`; what is pinned here is the emptiness decision itself,
//! reached through the same entry point the merge uses.

use super::*;

/// Build the drop plan for `models` exactly as `export_merged_models` does.
fn plan(models: &[&str]) -> DropPlan {
    let inputs: Vec<MergedModel> = models
        .iter()
        .enumerate()
        .map(|(i, m)| MergedModel { content: m.as_bytes(), id: i.to_string(), included: None })
        .collect();
    let first = ModelIndex::build(inputs[0].content);
    let order: Vec<u32> = first.order.clone();
    let lookup = SpatialLookup::build(
        &order,
        &|id| first.line_str(id),
        &|id| first.type_of.get(&id).cloned(),
    );
    let opts = MergedOptions { drop_empty_containers: true, ..Default::default() };
    let modes = crate::merged::units::resolve_model_modes(&inputs, opts.unit_reconciliation, 1.0);
    plan_drops(&inputs, &opts, &lookup, &modes, 1.0, "IFC4").expect("flag is set")
}

fn file(entities: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{entities}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Site → Building → two storeys; only the first storey contains a wall.
fn one_populated_storey() -> String {
    file(concat!(
        "#1=IFCPROJECT('p0',$,'P',$,$,$,$,$,$);\n",
        "#2=IFCSITE('s0',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n",
        "#3=IFCBUILDING('b0',$,'Building',$,$,$,$,$,$,$,$,$);\n",
        "#4=IFCBUILDINGSTOREY('l0',$,'Level 0',$,$,$,$,$,$,0.);\n",
        "#5=IFCBUILDINGSTOREY('l1',$,'Level 1',$,$,$,$,$,$,3000.);\n",
        "#6=IFCWALL('w0',$,'Wall',$,$,$,$,$,$);\n",
        "#7=IFCRELAGGREGATES('r0',$,$,$,#1,(#2));\n",
        "#8=IFCRELAGGREGATES('r1',$,$,$,#2,(#3));\n",
        "#9=IFCRELAGGREGATES('r2',$,$,$,#3,(#4,#5));\n",
        "#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('r3',$,$,$,(#6),#4);\n",
    ))
}

#[test]
fn drops_only_the_storey_that_holds_nothing() {
    let dropped = plan(&[&one_populated_storey()]);
    assert_eq!(dropped.count, 1);
    assert_eq!(dropped.per_model[0], HashSet::from([5]));
}

/// IFC4X3 facilities and facility parts are containers too (#5937): an empty
/// road part is dropped, and a populated one keeps its road.
#[test]
fn drops_an_empty_ifc4x3_facility_part_and_keeps_a_populated_one() {
    let road = file(concat!(
        "#1=IFCPROJECT('p0',$,'P',$,$,$,$,$,$);\n",
        "#2=IFCSITE('s0',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n",
        "#3=IFCROAD('rd',$,'Road',$,$,$,$,$,$,$);\n",
        "#4=IFCROADPART('p1',$,'Carriageway',$,$,$,$,$,$,$,$);\n",
        "#5=IFCROADPART('p2',$,'Shoulder',$,$,$,$,$,$,$,$);\n",
        "#6=IFCBRIDGE('br',$,'Bridge',$,$,$,$,$,$,$);\n",
        "#7=IFCPAVEMENT('pv',$,'Pavement',$,$,$,$,$,$);\n",
        "#8=IFCRELAGGREGATES('r0',$,$,$,#1,(#2));\n",
        "#9=IFCRELAGGREGATES('r1',$,$,$,#2,(#3,#6));\n",
        "#10=IFCRELAGGREGATES('r2',$,$,$,#3,(#4,#5));\n",
        "#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('r3',$,$,$,(#7),#4);\n",
    ));
    let dropped = plan(&[&road]);
    assert_eq!(dropped.per_model[0], HashSet::from([5, 6]), "the empty road part and the empty bridge go");
    assert_eq!(dropped.count, 2);
}

/// #5937: a later storey (another name and elevation, so it does not unify)
/// whose only element repeats the first model's contained wall by GlobalId. The
/// emit loop withholds that containment (#5923), so the storey holds nothing
/// and is dropped; the plan sees it only by resolving the wall's GlobalId.
#[test]
fn drops_a_storey_whose_only_element_unifies_by_globalid() {
    let later = file(concat!(
        "#1=IFCPROJECT('p1',$,'P',$,$,$,$,$,$);\n",
        "#2=IFCSITE('s1',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n",
        "#3=IFCBUILDING('b1',$,'Building',$,$,$,$,$,$,$,$,$);\n",
        "#4=IFCBUILDINGSTOREY('l9',$,'Mezzanine',$,$,$,$,$,$,7000.);\n",
        "#6=IFCWALL('0aBcDeFgHiJkLmNoPqRsT1',$,'Wall',$,$,$,$,$,$);\n",
        "#7=IFCRELAGGREGATES('q0',$,$,$,#1,(#2));\n",
        "#8=IFCRELAGGREGATES('q1',$,$,$,#2,(#3));\n",
        "#9=IFCRELAGGREGATES('q2',$,$,$,#3,(#4));\n",
        "#10=IFCRELCONTAINEDINSPATIALSTRUCTURE('q3',$,$,$,(#6),#4);\n",
    ));
    // The first model's wall carries a real (22-character) GlobalId to unify on.
    let first = one_populated_storey().replace("IFCWALL('w0'", "IFCWALL('0aBcDeFgHiJkLmNoPqRsT1'");
    let dropped = plan(&[&first, &later]);
    assert!(dropped.per_model[1].contains(&4), "the later storey holds only a unified wall");
    assert_eq!(dropped.per_model[0], HashSet::from([5]));
}

#[test]
fn keeps_ancestors_of_a_populated_container() {
    // Site and Building hold no element directly — only a storey that does — so
    // the upward sweep is the only thing keeping them.
    let dropped = plan(&[&one_populated_storey()]);
    assert!(!dropped.per_model[0].contains(&2), "site of a populated storey must stay");
    assert!(!dropped.per_model[0].contains(&3), "building of a populated storey must stay");
}

#[test]
fn a_container_only_a_later_model_fills_is_not_empty() {
    // Model A's storey is empty in A; model B's same-named storey carries a wall
    // and unifies onto it. Emptiness is a fact about the MERGED model, so the
    // storey survives — the reason this runs across every model, not per file.
    let a = file(concat!(
        "#1=IFCPROJECT('p0',$,'P',$,$,$,$,$,$);\n",
        "#2=IFCSITE('s0',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n",
        "#3=IFCBUILDING('b0',$,'Building',$,$,$,$,$,$,$,$,$);\n",
        "#4=IFCBUILDINGSTOREY('l0',$,'Level 0',$,$,$,$,$,$,0.);\n",
        "#5=IFCRELAGGREGATES('r0',$,$,$,#1,(#2));\n",
        "#6=IFCRELAGGREGATES('r1',$,$,$,#2,(#3));\n",
        "#7=IFCRELAGGREGATES('r2',$,$,$,#3,(#4));\n",
    ));
    let b = file(concat!(
        "#1=IFCPROJECT('p1',$,'P',$,$,$,$,$,$);\n",
        "#2=IFCSITE('s1',$,'Site',$,$,$,$,$,$,$,$,$,$,$);\n",
        "#3=IFCBUILDING('b1',$,'Building',$,$,$,$,$,$,$,$,$);\n",
        "#4=IFCBUILDINGSTOREY('l1',$,'Level 0',$,$,$,$,$,$,0.);\n",
        "#5=IFCWALL('w1',$,'Wall',$,$,$,$,$,$);\n",
        "#6=IFCRELAGGREGATES('r1',$,$,$,#3,(#4));\n",
        "#7=IFCRELCONTAINEDINSPATIALSTRUCTURE('r2',$,$,$,(#5),#4);\n",
    ));
    let dropped = plan(&[&a, &b]);
    assert_eq!(dropped.count, 0, "no container is empty once both models are in");
    assert!(dropped.per_model.iter().all(HashSet::is_empty));
}

#[test]
fn a_container_a_non_relationship_names_is_kept() {
    // Nothing can rewrite a reference from a non-relationship entity, so an
    // otherwise-empty space stays rather than leaving a dangling `#ref`.
    let model = file(concat!(
        "#1=IFCPROJECT('p0',$,'P',$,$,$,$,$,$);\n",
        "#2=IFCSPACE('sp0',$,'Space',$,$,$,$,$,$,$,$);\n",
        "#3=IFCRELAGGREGATES('r0',$,$,$,#1,(#2));\n",
        "#4=IFCX('x',(#2));\n",
    ));
    assert_eq!(plan(&[&model]).count, 0);
}

#[test]
fn ref_helpers_read_step_attributes() {
    assert_eq!(single_ref(" #42 "), Some(42));
    assert_eq!(single_ref("$"), None);
    assert_eq!(ref_list("(#1,#2)"), vec![1, 2]);
    assert_eq!(ref_list("()"), Vec::<u32>::new());
    assert!(is_container_type("IFCSPACE"));
    assert!(!is_container_type("IFCPROJECT"), "the project root is never a candidate");
}
