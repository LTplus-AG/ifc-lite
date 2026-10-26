// SPDX-License-Identifier: MPL-2.0
//! Builders shared by the Add tests: a plain object description, two
//! shapes, and a run-and-report helper. Synthetic, like every fixture here.

use super::add_types::*;
use super::attrs::attribute_index;
use super::execute;
use super::index::FileIndex;
use super::types::*;

pub(super) use super::placement::IDENTITY;

pub(super) const SCHEMAS: [&str; 3] = ["IFC2X3", "IFC4", "IFC4X3"];

pub(super) fn gid(n: u128) -> GlobalId {
    GlobalId(0x5eed_0000_0000_0000_0000_0000_0000_0000 + n)
}

/// A `w` x `d` rectangle extruded `h` straight up.
pub(super) fn block(w: f64, d: f64, h: f64) -> Extrusion {
    Extrusion { profile: vec![[0.0, 0.0], [w, 0.0], [w, d], [0.0, d]], voids: Vec::new(), direction: [0.0, 0.0, 1.0], depth: h }
}

/// A closed, outward-facing tetrahedron.
pub(super) fn tetrahedron() -> TriangleMesh {
    TriangleMesh {
        positions: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        triangles: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
    }
}

pub(super) fn object(class: IfcClass, id: GlobalId, container: Option<ObjectRef>, representation: Representation) -> NewObject {
    let mut obj = NewObject::new(id, class, NewPlacement::new(IDENTITY)).with_name("Added").with_representation(representation);
    obj.container = container;
    obj
}

pub(super) fn add(obj: NewObject) -> (ObjectRef, Disposition) {
    (ObjectRef::Guid(obj.global_id.encode()), Disposition::Add(Box::new(obj)))
}

pub(super) fn run(source: &[u8], dispositions: Vec<(ObjectRef, Disposition)>) -> (Vec<u8>, WriteReport) {
    run_with(source, dispositions, PlanContext::attributed())
}

pub(super) fn run_with(source: &[u8], dispositions: Vec<(ObjectRef, Disposition)>, context: PlanContext) -> (Vec<u8>, WriteReport) {
    let plan = ExportPlan { dispositions, context };
    let mut out = Vec::new();
    let report = execute(source, &plan, &mut out).expect("execute");
    (out, report)
}

/// Attribute `name` of output record `id`, as STEP text.
pub(super) fn attr(out: &[u8], schema: &str, id: u32, name: &str) -> String {
    let index = FileIndex::scan(out, &Default::default());
    let entity = index.type_of(id).unwrap_or_else(|| panic!("#{id} is not in the output ({schema})"));
    let idx = attribute_index(schema, &entity, name).unwrap_or_else(|| panic!("{entity} has no {name}"));
    crate::step_text::attribute_of(&index.raw_line(id).unwrap(), idx).unwrap()
}

pub(super) fn assert_clean(report: &WriteReport, what: &str) {
    assert!(report.refusals.is_empty(), "{what}: refusals {:?}", report.refusals);
    assert!(report.findings.is_empty(), "{what}: findings {:?}", report.findings);
}

/// The express id the output gave the object with GlobalId `g`.
pub(super) fn id_in(out: &[u8], g: GlobalId) -> u32 {
    let encoded = g.encode();
    let wanted: rustc_hash::FxHashSet<&str> = [encoded.as_str()].into_iter().collect();
    FileIndex::scan(out, &wanted).resolve(&ObjectRef::Guid(encoded.clone())).unwrap_or_else(|| panic!("{encoded} not in output"))
}

/// Ids of every `entity` record in the output, in file order.
pub(super) fn ids_of_type(out: &[u8], entity: &str) -> Vec<u32> {
    let index = FileIndex::scan(out, &Default::default());
    index.records().filter(|(_, t, _, _)| t.eq_ignore_ascii_case(entity)).map(|(id, _, _, _)| id).collect()
}

pub(super) fn count(out: &[u8], entity: &str) -> usize {
    ids_of_type(out, entity).len()
}

/// UPPERCASE type of record `id` in the output.
pub(super) fn type_in(out: &[u8], id: u32) -> String {
    FileIndex::scan(out, &Default::default()).type_of(id).unwrap_or_default()
}
