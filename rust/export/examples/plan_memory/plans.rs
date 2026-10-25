// SPDX-License-Identifier: MPL-2.0
//! Export plans against a [`super::synth`] model, by the ids its layout
//! defines. `benchmark` is what the memory harness runs; `scenarios` is the
//! wider set the output-pinning test runs.

use ifc_lite_export::plan::{
    Disposition, ExportPlan, GeometryPatch, GlobalId, IfcClass, NewObject, NewPlacement, ObjectRef, Patch, PlacementPatch,
    PlanContext, PropScope, PropWrite, PsetKind, SurfaceColour, TriangleMesh,
};

use super::synth::{quirk, Layout, GROUP, TYPES};

fn context() -> PlanContext {
    PlanContext::new().with_author("harness").with_organization("synthetic").with_time_stamp("0")
}

fn shifted(x: f64) -> PlacementPatch {
    PlacementPatch::new([[1.0, 0.0, 0.0, x], [0.0, 1.0, 0.0, 0.5], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
}

fn place(id: u32, x: f64) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch::new().with_placement(shifted(x))))
}

fn prop(pset: &str, name: &str, measure: &str, literal: &str, kind: PsetKind, scope: PropScope) -> PropWrite {
    PropWrite::new(pset, name, measure, literal, kind, scope)
}

fn props(id: u32, writes: Vec<PropWrite>) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Patch(Patch::new().with_psets(writes)))
}

/// An Add keyed by `id`, which already exists: refused, and writes nothing.
fn add_over_existing(id: u32) -> (ObjectRef, Disposition) {
    let new = NewObject::new(GlobalId(u128::from(id)), IfcClass::Wall, NewPlacement::new(shifted(0.0).matrix));
    (ObjectRef::Id(id), Disposition::Add(Box::new(new)))
}

fn delete(id: u32) -> (ObjectRef, Disposition) {
    (ObjectRef::Id(id), Disposition::Delete)
}

fn plan(dispositions: Vec<(ObjectRef, Disposition)>) -> ExportPlan {
    ExportPlan::new(dispositions).with_context(context())
}

/// About a hundred placement patches, a few property writes and a few
/// deletes, spread across the whole model.
pub fn benchmark(l: &Layout) -> ExportPlan {
    let stride = (l.walls / 100).max(1);
    let mut d: Vec<(ObjectRef, Disposition)> =
        (0..100).map(|i| (i * stride) % l.walls).map(|k| place(l.wall(k), k as f64 * 0.1)).collect();
    let mid = l.walls / 2 + 1;
    d.push(props(l.wall(mid), vec![prop("Pset_Own", "Reference", "IFCIDENTIFIER", "'patched'", PsetKind::Property, PropScope::Occurrence)]));
    d.push(props(l.wall(mid + 1), vec![prop("Qto_Base", "Length", "IFCLENGTHMEASURE", "6.5", PsetKind::Quantity, PropScope::Occurrence)]));
    d.push(props(l.wall(mid + 2), vec![prop("Pset_Shared", "Grade", "IFCLABEL", "'changed'", PsetKind::Property, PropScope::Occurrence)]));
    d.push(props(l.wall(mid + 3), vec![prop("Pset_Extra", "Checked", "IFCBOOLEAN", ".T.", PsetKind::Property, PropScope::Occurrence)]));
    for k in [l.walls / 3, l.walls / 3 + 7, 2 * l.walls / 3 + 3] {
        d.push(delete(l.wall(k)));
    }
    plan(d)
}

/// Every storey below `storeys` deleted together with every wall it
/// contains: tens of thousands of deletions under the few large
/// relationships they share (containment, typing, shared property sets).
pub fn bulk_delete(l: &Layout, storeys: u32) -> ExportPlan {
    let walls = (0..l.walls).filter(|&k| l.storey_of(k) < storeys).map(|k| delete(l.wall(k)));
    plan((0..storeys).map(|s| delete(l.storey(s))).chain(walls).collect())
}

/// A closed `x` by `y` by `z` box with a corner at the origin, 12 triangles.
fn box_mesh(x: f64, y: f64, z: f64) -> TriangleMesh {
    let positions = (0..8).map(|i| [if i & 1 == 0 { 0.0 } else { x }, if i & 2 == 0 { 0.0 } else { y }, if i & 4 == 0 { 0.0 } else { z }]).collect();
    let triangles = vec![
        [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4],
        [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
    ];
    TriangleMesh::new(positions, triangles)
}

/// New bodies for `count` walls spread across the model, every other one
/// coloured.
pub fn geometry(l: &Layout, count: u32) -> ExportPlan {
    let count = count.min(l.walls);
    let stride = (l.walls / count.max(1)).max(1);
    let d = (0..count)
        .map(|i| {
            let k = i * stride;
            let colour = (i % 2 == 0).then_some(SurfaceColour::new([0.6, 0.4, 0.2], 0.0));
            let mut patch = GeometryPatch::new(box_mesh(5.0, 0.2, 3.0 + f64::from(i % 3)));
            patch.colour = colour;
            (ObjectRef::Id(l.wall(k)), Disposition::Patch(Patch::new().with_geometry(patch)))
        })
        .collect();
    plan(d)
}

/// Every plan the pinning test runs, by name. Sized for a small model
/// (`walls` around a hundred, a few storeys, quirks on).
pub fn scenarios(l: &Layout) -> Vec<(&'static str, ExportPlan)> {
    let q = l.quirks_base();
    let w = |k| l.wall(k);
    let occ = PropScope::Occurrence;
    vec![
        ("preserve", plan(vec![(ObjectRef::Id(w(0)), Disposition::Preserve)])),
        (
            "rename_by_guid",
            plan(vec![(
                ObjectRef::Guid(format!("{:0>22}", w(3))),
                Disposition::Patch(Patch::new().with_name("Renamed 'quoted'")),
            )]),
        ),
        ("placements", plan((0..12).map(|k| place(w(k), k as f64)).collect())),
        (
            "props",
            plan(vec![
                props(w(5), vec![prop("Pset_Own", "Reference", "IFCIDENTIFIER", "'in place'", PsetKind::Property, occ)]),
                props(w(6), vec![prop("Pset_Own", "Added", "IFCLABEL", "'folded'", PsetKind::Property, occ)]),
                props(w(9), vec![prop("Qto_Base", "Length", "IFCLENGTHMEASURE", "7.", PsetKind::Quantity, occ)]),
                props(w(7), vec![prop("Pset_Shared", "Grade", "IFCLABEL", "'cow'", PsetKind::Property, occ)]),
                props(w(8), vec![prop("Pset_Type", "FireRating", "IFCLABEL", "'9HR'", PsetKind::Property, PropScope::Type)]),
                props(w(11), vec![prop("Pset_Type", "FireRating", "IFCLABEL", "'1HR'", PsetKind::Property, occ)]),
                props(w(12), vec![prop("Pset_Type", "Missing", "IFCLABEL", "'x'", PsetKind::Property, PropScope::Type)]),
            ]),
        ),
        ("delete_with_opening_and_boundary", plan(vec![delete(w(70)), delete(w(14))])),
        ("delete_storey", plan(vec![delete(l.storey(1))])),
        ("delete_storey_placement", plan(vec![delete(l.storey_placement(0))])),
        ("delete_whole_group", plan((0..GROUP.min(l.walls)).map(|k| delete(w(k))).collect())),
        ("delete_type", plan(vec![delete(l.wall_type(TYPES - 1))])),
        (
            "delete_wins_and_unknowns",
            plan(vec![
                delete(w(20)),
                place(w(20), 1.0),
                delete(99_999_998),
                (ObjectRef::Guid("NoSuchGlobalIdAnywhere".into()), Disposition::Delete),
                add_over_existing(w(21)),
            ]),
        ),
        (
            "quirks",
            plan(vec![
                place(q + quirk::MIXED_CASE_WALL, 1.0),
                place(q + quirk::OUT_OF_ORDER_WALL, 2.0),
                place(q + quirk::SHARED_PLACEMENT_WALL, 3.0),
                place(q + quirk::GRID_WALL, 4.0),
                delete(q + quirk::COMMENTED_WALL),
                props(q + quirk::OUT_OF_ORDER_WALL, vec![prop("Pset_New", "A", "IFCLABEL", "'a'", PsetKind::Property, occ)]),
            ]),
        ),
        ("benchmark", benchmark(l)),
        ("geometry", geometry(l, 8)),
        ("bulk_delete", bulk_delete(l, 2)),
    ]
}
