// SPDX-License-Identifier: MPL-2.0
//! [`super::super::Disposition::AddType`]: a type added on its own, with no
//! occurrence, and the type a `TypeLink::New` creates beside one. A child of
//! `add` so it shares the Add's checks, owner history and relationships.
//!
//! IFC4 and IFC4X3 declare a type to the project through `IfcRelDeclares`,
//! so an exchange can find a type nothing instances; one relationship holds
//! every type a plan adds this way, extending the project's own when it has
//! one. IFC2X3 has no `IfcRelDeclares` and no other relationship that ties a
//! type to a project: there the type is written on its own, found by its
//! GlobalId, until an occurrence is typed by it.

use std::collections::HashMap;

use ifc_lite_core::entity_info_for_schema;

use crate::step_ids::IdAllocator;
use crate::step_text::escape;

use crate::plan::add_props::build_sets;
use crate::plan::add_rels::{RelKind, RelRequest};
use crate::plan::add_types::{GlobalId, NewType, Representation};
use crate::plan::props_synth::{ref_list, ref_or_unset};
use crate::plan::tessellation::Emit;
use crate::plan::types::{ObjectRef, ValidationFinding};
use super::assoc::Shared;
use super::mapped::{build_map, MapRef};
use super::units::build_units;
use super::{require_filled, AddState};

impl AddState<'_, '_> {
    /// Build a type on its own, or refuse it whole.
    pub(super) fn add_type(&mut self, key: &ObjectRef, t: &NewType, ids: &mut IdAllocator) -> Result<(), String> {
        let gid = t.global_id.ok_or("a type added on its own needs its own GlobalId")?;
        self.check_new_identity(key, &gid.encode())?;
        let (class, predefined, units) = self.check_new_type(t)?;
        let project = entity_info_for_schema(self.schema, "IFCRELDECLARES")
            .map(|_| self.live_project().ok_or("the file has no IfcProject to declare the type to"))
            .transpose()?;

        let mut out = Vec::new();
        let owner = self.owner_history_for(ids, &mut out)?;
        let mut shared = Shared { committed: &self.shared, pending: HashMap::new() };
        let mut emit = Emit { schema: self.schema, ids, out: &mut out };
        let units = build_units(&mut emit, &mut shared, &units)?;
        let (maps, new_context) = match t.representation {
            Representation::None => (Vec::new(), None),
            _ => {
                let (context, new_context) = self.body_context_or_new(&mut emit)?;
                (build_map(&mut emit, context, &t.representation, t.style.as_ref())?, new_context)
            }
        };
        let id = build_new_type(&mut emit, t, gid, (&class, &predefined), &units, &maps, Some(owner.id))?;
        let pending = shared.pending;
        let new_context = self.owned_context(new_context)?;

        self.commit(owner, out, pending);
        if let Some((context, owner)) = new_context {
            self.adopt_context(context, owner);
        }
        match project {
            Some(project) => self.rels.relate(self.schema, RelRequest { kind: RelKind::Declares, relating: project, related: id, seed: gid }),
            None => self.notes.push(ValidationFinding {
                express_id: Some(id),
                message: format!("{} has no IfcRelDeclares in {}: the type is written on its own until an occurrence is typed by it", t.global_id_for(gid).encode(), self.schema),
            }),
        }
        self.register_type(id, gid, class, maps);
        Ok(())
    }
}

/// A new type's record and its own property sets, for a `TypeLink::New` or
/// a type added on its own. `class` is its checked class and
/// `PredefinedType`. A type without its own GlobalId takes one derived from
/// `owner`, the occurrence that creates it, and so do its sets.
pub(super) fn build_new_type(
    emit: &mut Emit,
    t: &NewType,
    owner: GlobalId,
    class: (&str, &Option<String>),
    units: &[Vec<Option<u32>>],
    maps: &[MapRef],
    owner_history: Option<u32>,
) -> Result<u32, String> {
    // A type with its own GlobalId derives its sets' ids from it.
    let (base, role) = t.global_id.map_or((owner, "type/pset"), |g| (g, "pset"));
    let type_sets = build_sets(emit, owner_history, base, role, &t.psets, units)?;
    let type_gid = format!("'{}'", t.global_id_for(owner).encode());
    let mut fields = vec![("GlobalId", type_gid), ("OwnerHistory", ref_or_unset(owner_history))];
    if let Some(name) = &t.name {
        fields.push(("Name", format!("'{}'", escape(name))));
    }
    if !type_sets.is_empty() {
        fields.push(("HasPropertySets", ref_list(&type_sets)));
    }
    if !maps.is_empty() {
        let ids: Vec<u32> = maps.iter().map(|&(map, _)| map).collect();
        fields.push(("RepresentationMaps", ref_list(&ids)));
    }
    // Mandatory on element types in IFC4 and later (and on door and window
    // types, their operation and partitioning; on furniture types, the
    // assembly place): NOTDEFINED claims nothing when the caller names no
    // value.
    let notdefined = || ".NOTDEFINED.".to_string();
    fields.push(("PredefinedType", class.1.clone().unwrap_or_else(notdefined)));
    fields.push(("OperationType", notdefined()));
    fields.push(("PartitioningType", notdefined()));
    fields.push(("AssemblyPlace", notdefined()));
    let id = emit.record(class.0, &fields)?;
    require_filled(emit, id)?;
    Ok(id)
}

#[cfg(test)]
#[path = "add_type_tests.rs"]
mod tests;
