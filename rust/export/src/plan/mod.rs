// SPDX-License-Identifier: MPL-2.0
//! The export-plan executor: callers speak IFC (objects by express id or
//! GlobalId, properties by measure type, placements by matrix), and
//! [`execute`] is the one place that lowers a plan into the STEP-level
//! primitives the rest of this crate already carries
//! (`AttrMutation`-shaped edits, `CopyOnWriteMutation`'s copy-then-repoint
//! shape, [`crate::step_cow`]'s id allocator role) plus the parts no STEP
//! option expresses: occurrence overrides, placement rewrites, body geometry
//! replacement, and delete with reverse-reference repair.
//! [`Disposition::Add`] builds a new object (placement, geometry,
//! containment, type, property sets, material, classifications, an opening
//! in a host) from an IFC-level description; see `add.rs`.
//! [`Disposition::AddType`] adds a type nothing instances yet.
//!
//! # Design
//!
//! Memory follows the plan, not the file. [`index::FileIndex::scan`] makes
//! one pass that keeps where each record is and little else; attributes are
//! parsed on demand, only for records the plan reaches; who refers to a
//! record is collected by [`referrers`] only for the records a plan asks
//! about, in streaming passes over the file that repeat until
//! [`resolve::resolve`] completes without asking about anything new
//! ([`referrers`] explains how many passes that takes, and why).
//! [`write::write_output`] then streams the output in file order, validating
//! each record as it goes. A single [`crate::step_ids::IdAllocator`], the one
//! every STEP writer in this crate allocates with, is threaded through every
//! appender so a plan's copy-on-write, an occurrence override, and a
//! synthesized owner history can never land on the same id.
//!
//! # What this does not do
//!
//! - It does not convert between IFC2X3/IFC4/IFC4X3 — `crate::schema_convert`
//!   already does that, as a separate concern a caller composes with this one.
//! - A property or quantity write never edits a shared record in place.
//!   Sharing is judged at the set (how many relationships or types reach it)
//!   and at the value (how many sets list it); either one shared means a
//!   copy, or a refusal for a set shared between types.

mod add;
mod add_assoc_types;
mod add_builders;
mod add_geometry;
mod add_profile;
mod add_props;
mod add_rels;
mod add_types;
mod attribution;
mod attrs;
mod builders;
mod delete;
mod geometry;
mod identity;
mod index;
mod orphans;
mod owner_history;
mod placement;
mod patch;
mod props;
mod props_lookup;
mod props_synth;
mod props_target;
mod referrers;
mod removal;
mod resolve;
mod skeleton;
mod source_text;
mod tessellation;
#[cfg(test)]
mod add_test_support;
#[cfg(test)]
mod test_fixtures;
mod types;
mod validate;
mod write;

pub use add_assoc_types::{
    ClassificationLink, ClassificationSystem, LayerMaterial, MaterialLink, NewClassification, NewClassificationReference,
    NewLayerSet, NewMaterial, NewMaterialLayer, ValueUnit,
};
pub use add_types::{
    ClassSpec, Extrusion, GlobalId, IfcClass, MappedBody, NewObject, NewOpening, NewPlacement, NewProperty, NewPropertySet, NewType,
    PropertyValue, Representation, TypeLink,
};
pub use placement::IDENTITY;
pub use removal::{Removal, RemovalReason};
pub use skeleton::{skeleton, skeleton_with_findings, MapConversion, MapUnit, Skeleton, SkeletonRoot, SKELETON_SCHEMA};
pub use types::{
    Disposition, DroppedRepresentation, ExportPlan, ExportingApplication, ExportingPerson, GeometryPatch, ObjectRef, Patch, PlacementPatch, PlanContext, PlanError,
    PropScope, PropWrite, PsetKind, Refusal, SurfaceColour, TriangleMesh, ValidationFinding, WriteReport,
};

use rustc_hash::FxHashSet;

use index::FileIndex;

/// Execute `plan` against `source`, writing the result to `out`.
///
/// Callers never pass express ids for attributes or attribute indices, only
/// [`ObjectRef`], property values as STEP literals with their measure type
/// (each checked to be one value), and a 4x4 placement matrix. See the
/// module docs for what is deliberately out of scope. `out` is buffered here.
pub fn execute<W: std::io::Write>(source: &[u8], plan: &ExportPlan, out: W) -> Result<WriteReport, PlanError> {
    // An Add's own GlobalId is looked up too: it must not already be in use.
    let add_guids: Vec<String> = plan
        .dispositions
        .iter()
        .filter_map(|(_, d)| match d {
            Disposition::Add(new) => Some(new.guids_to_look_up()),
            Disposition::AddType(t) => Some(t.guids_to_look_up()),
            _ => None,
        })
        .flatten()
        .collect();
    let guids: FxHashSet<&str> = plan
        .dispositions
        .iter()
        .filter_map(|(obj, _)| match obj {
            ObjectRef::Guid(g) => Some(g.as_str()),
            ObjectRef::Id(_) => None,
        })
        .chain(add_guids.iter().map(String::as_str))
        .collect();
    let mut index = FileIndex::scan(source, &guids);
    let schema = crate::schema_detect::detect_schema(source);
    let resolution = loop {
        let resolution = resolve::resolve(&index, &schema, plan);
        if !index.collect_missing_referrers() {
            break resolution;
        }
    };
    write::write_output(&index, &schema, plan, resolution, out)
}

#[cfg(test)]
#[path = "exec_tests.rs"]
mod exec_tests;
#[cfg(test)]
#[path = "combination_tests.rs"]
mod combination_tests;
#[cfg(test)]
#[path = "identity_tests.rs"]
mod identity_tests;
