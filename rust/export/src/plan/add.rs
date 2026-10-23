// SPDX-License-Identifier: MPL-2.0
//! [`super::Disposition::Add`]: build a new object from its IFC-level
//! description.
//!
//! Each Add runs in two phases. [`AddState::check`] resolves every reference
//! the description makes (container, parent placement, type, host) and
//! validates every value against the source schema WITHOUT allocating an id,
//! so a refused Add leaves no trace. Only then does the build allocate ids
//! and write records, and those reach the output only if the whole object
//! built. Relationships are requested, not written, and land through
//! [`super::add_rels::RelAccumulator`] after every Add has run.
//!
//! Objects added earlier in the same plan can be named by later ones through
//! their GlobalId: a wall into a storey the plan also adds, two doors of one
//! new type.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_text::escape;
use crate::step_ids::IdAllocator;

use super::add_geometry::product_shape;
use super::add_props::build_sets;
use super::add_rels::{RelAccumulator, RelKind, RelRequest};
use super::add_types::{NewObject, Representation, TypeLink};
use super::attrs::{attribute_index, unset_required};
use super::index::FileIndex;
use super::owner_history;
use super::props_synth::{defines_by_properties_record, ref_list, ref_or_unset};
use super::tessellation::{find_body_context, synthesize_context, Emit};
use super::types::{ObjectRef, PlanContext, Refusal};

use check::Checked;

/// An object this plan added, as later Adds see it.
struct Added {
    id: u32,
    class: String,
}

pub(crate) struct AddState<'a> {
    index: &'a FileIndex<'a>,
    schema: &'a str,
    removed: &'a HashSet<u32>,
    context: &'a PlanContext,
    owner_history: Option<u32>,
    added: HashMap<String, Added>,
    /// Each added object's placement, by id, for children placed under it.
    placement_of_added: HashMap<u32, Option<u32>>,
    body_context: Option<u32>,
    rels: RelAccumulator<'a>,
    records: Vec<(u32, String)>,
}

impl<'a> AddState<'a> {
    /// `owner_history` is the one the source (or a patch) already provides;
    /// when there is none, the first Add that builds synthesizes it, so a
    /// plan whose Adds are all refused writes nothing at all.
    /// `body_context` is the one this plan's geometry patches already wrote
    /// into, if any; otherwise the file's own is looked up, and one is
    /// synthesized only when there is none.
    pub(crate) fn new(
        index: &'a FileIndex<'a>,
        schema: &'a str,
        removed: &'a HashSet<u32>,
        context: &'a PlanContext,
        owner_history: Option<u32>,
        body_context: Option<u32>,
    ) -> Self {
        Self {
            index,
            schema,
            removed,
            context,
            owner_history,
            added: HashMap::new(),
            placement_of_added: HashMap::new(),
            body_context: body_context.or_else(|| find_body_context(index, schema, removed)),
            rels: RelAccumulator::new(index, removed),
            records: Vec::new(),
        }
    }

    /// Build one object, or refuse it whole.
    fn add(&mut self, key: &ObjectRef, obj: &NewObject, ids: &mut IdAllocator) -> Result<(), String> {
        let checked = self.check(key, obj)?;
        let mut out = Vec::new();
        let owner_history = match self.owner_history {
            Some(id) => id,
            None => {
                let (records, id) = owner_history::synthesize(self.schema, ids, self.context).ok_or("id space exhausted")?;
                out.extend(records);
                id
            }
        };
        let mut requests = Vec::new();
        let mut emit = Emit { schema: self.schema, ids, out: &mut out };
        let built = self.build(&mut emit, obj, &checked, owner_history, &mut requests)?;
        // A context this Add synthesizes must be owned by the project.
        let new_context = match built.new_context {
            None => None,
            Some(context) => {
                let project = self.index.projects.iter().copied().find(|id| !self.removed.contains(id));
                match (project, attribute_index(self.schema, "IFCPROJECT", "RepresentationContexts")) {
                    (Some(project), Some(idx)) => Some((context, project, idx)),
                    _ => return Err("the file has no IfcProject to own a new representation context".into()),
                }
            }
        };

        self.owner_history = Some(owner_history);
        self.records.extend(out);
        for req in requests {
            self.rels.relate(self.schema, req);
        }
        if let Some((context, project, idx)) = new_context {
            self.body_context = Some(context);
            self.rels.append_to_list(project, idx, context);
        }
        let gid = obj.global_id;
        self.placement_of_added.insert(built.object, Some(built.placement));
        self.added.insert(gid.encode(), Added { id: built.object, class: checked.class });
        if let (Some(type_id), Some((class, _))) = (built.new_type, checked.new_type) {
            self.placement_of_added.insert(type_id, None);
            self.added.insert(gid.derive("type").encode(), Added { id: type_id, class });
        }
        Ok(())
    }

    /// Build every Add, returning how many were written. The relationships of
    /// every Add are written together, all or nothing: when `finish` fails (the
    /// id space runs out, or a list it extends does not scan), it discards every
    /// built object's records along with them (see its doc comment), so each Add
    /// that had built is refused too.
    pub(crate) fn build_all(
        mut self,
        adds: &[(&ObjectRef, &NewObject)],
        ids: &mut IdAllocator,
        edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
        appended: &mut Vec<(u32, String)>,
        refusals: &mut Vec<Refusal>,
    ) -> usize {
        let mut built = Vec::new();
        for &(key, new) in adds {
            // A refused Add gives back the ids it took, so it changes no
            // later Add's ids or headroom.
            let before = *ids;
            match self.add(key, new, ids) {
                Ok(()) => built.push(key),
                Err(reason) => {
                    *ids = before;
                    refusals.push(Refusal { object: key.clone(), reason });
                }
            }
        }
        match self.finish(ids, edits_by_id) {
            Ok(records) => {
                appended.extend(records);
                built.len()
            }
            Err(reason) => {
                refusals.extend(built.into_iter().map(|key| Refusal {
                    object: key.clone(),
                    reason: format!("relationships for added objects not written: {reason}"),
                }));
                0
            }
        }
    }

    /// Every record and list edit the Adds produced, relationships last.
    fn finish(
        self,
        ids: &mut IdAllocator,
        edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
    ) -> Result<Vec<(u32, String)>, String> {
        let mut records = self.records;
        records.extend(self.rels.finish(self.schema, ids, self.owner_history, edits_by_id)?);
        Ok(records)
    }

    fn build(
        &self,
        emit: &mut Emit,
        obj: &NewObject,
        c: &Checked,
        owner_history: u32,
        requests: &mut Vec<RelRequest>,
    ) -> Result<Built, String> {
        let gid = obj.global_id;
        let owh = format!("#{owner_history}");
        let owner_history = Some(owner_history);
        let guid = |role: &str| format!("'{}'", gid.derive(role).encode());

        let a2p = emit.axis_placement(&obj.placement.matrix)?;
        let placement = emit.record(
            "IFCLOCALPLACEMENT",
            &[("PlacementRelTo", ref_or_unset(c.parent_placement)), ("RelativePlacement", format!("#{a2p}"))],
        )?;

        let needs_context = !matches!(obj.representation, Representation::None) || c.host.is_some();
        let mut new_context = None;
        let context = match (needs_context, self.body_context) {
            (false, _) => None,
            (true, Some(existing)) => Some(existing),
            (true, None) => {
                let id = synthesize_context(emit)?;
                new_context = Some(id);
                Some(id)
            }
        };
        let shape = match context {
            Some(ctx) => product_shape(emit, ctx, &obj.representation, obj.style.as_ref())?,
            None => None,
        };

        let mut fields = vec![
            ("GlobalId", format!("'{}'", gid.encode())),
            ("OwnerHistory", owh.clone()),
            ("ObjectPlacement", format!("#{placement}")),
        ];
        if let Some(name) = &obj.name {
            fields.push(("Name", format!("'{}'", escape(name))));
        }
        if let Some(shape) = shape {
            fields.push(("Representation", format!("#{shape}")));
        }
        if let Some(p) = &c.predefined {
            fields.push(("PredefinedType", p.clone()));
        }
        if self.is_a(&c.class, "IFCSPATIALSTRUCTUREELEMENT") {
            // Mandatory in IFC2X3; ELEMENT is what a single storey or space is.
            fields.push(("CompositionType", ".ELEMENT.".into()));
        }
        let object = emit.record(&c.class, &fields)?;
        require_filled(emit, object)?;

        let set_ids = build_sets(emit, owner_history, gid, "pset", &obj.psets)?;
        for (set, spec) in set_ids.iter().zip(&obj.psets) {
            let id = emit.ids.allocate().ok_or("id space exhausted")?;
            let rel_guid = gid.derive(&format!("rel/pset/{}", spec.name)).encode();
            emit.out.push((id, defines_by_properties_record(self.schema, id, &rel_guid, owner_history, &[object], *set)));
        }

        let mut new_type = None;
        let type_target = match (&obj.type_link, &c.new_type) {
            (Some(TypeLink::New(t)), Some((class, predefined))) => {
                let type_sets = build_sets(emit, owner_history, gid, "type/pset", &t.psets)?;
                let mut fields = vec![("GlobalId", guid("type")), ("OwnerHistory", owh.clone())];
                if let Some(name) = &t.name {
                    fields.push(("Name", format!("'{}'", escape(name))));
                }
                if !type_sets.is_empty() {
                    fields.push(("HasPropertySets", ref_list(&type_sets)));
                }
                // Mandatory on element types in IFC4 and later (and on door
                // and window types, their operation and partitioning):
                // NOTDEFINED claims nothing when the caller names no value.
                let notdefined = || ".NOTDEFINED.".to_string();
                fields.push(("PredefinedType", predefined.clone().unwrap_or_else(notdefined)));
                fields.push(("OperationType", notdefined()));
                fields.push(("PartitioningType", notdefined()));
                let id = emit.record(class, &fields)?;
                require_filled(emit, id)?;
                new_type = Some(id);
                Some(id)
            }
            _ => c.existing_type,
        };
        if let Some(t) = type_target {
            requests.push(RelRequest { kind: RelKind::DefinesByType, relating: t, related: object, seed: gid });
        }
        if let Some((container, kind)) = c.container {
            requests.push(RelRequest { kind, relating: container, related: object, seed: gid });
        }

        if let (Some(host), Some(op), Some(ctx)) = (c.host, &obj.opening, context) {
            let a2p = emit.identity_placement()?;
            let op_placement = emit.record(
                "IFCLOCALPLACEMENT",
                &[("PlacementRelTo", format!("#{placement}")), ("RelativePlacement", format!("#{a2p}"))],
            )?;
            let op_shape = product_shape(emit, ctx, &Representation::Extrusion(op.shape.clone()), None)?.ok_or("opening shape")?;
            let mut fields = vec![
                ("GlobalId", guid("opening")),
                ("OwnerHistory", owh.clone()),
                ("Name", "'Opening'".into()),
                ("ObjectPlacement", format!("#{op_placement}")),
                ("Representation", format!("#{op_shape}")),
            ];
            if attribute_index(self.schema, "IFCOPENINGELEMENT", "PredefinedType").is_some() {
                fields.push(("PredefinedType", ".OPENING.".into()));
            }
            let opening = emit.record("IFCOPENINGELEMENT", &fields)?;
            emit.record(
                "IFCRELVOIDSELEMENT",
                &[
                    ("GlobalId", guid("rel/voids")),
                    ("OwnerHistory", owh.clone()),
                    ("RelatingBuildingElement", format!("#{host}")),
                    ("RelatedOpeningElement", format!("#{opening}")),
                ],
            )?;
            if c.fills {
                emit.record(
                    "IFCRELFILLSELEMENT",
                    &[
                        ("GlobalId", guid("rel/fills")),
                        ("OwnerHistory", owh),
                        ("RelatingOpeningElement", format!("#{opening}")),
                        ("RelatedBuildingElement", format!("#{object}")),
                    ],
                )?;
            }
        }

        Ok(Built { object, placement, new_type, new_context })
    }
}

/// Refuse a record the build left without a value its schema requires,
/// such as an `IfcGrid`'s axes: an Add writes only the attributes common to
/// the products it supports.
fn require_filled(emit: &Emit, id: u32) -> Result<(), String> {
    let Some((_, text)) = emit.out.iter().rev().find(|(i, _)| *i == id) else { return Ok(()) };
    let unset = unset_required(emit.schema, text);
    if unset.is_empty() {
        return Ok(());
    }
    let entity = crate::step_record_frame::record_head(text).map_or("", |head| head.type_name(text));
    Err(format!("{entity} requires {} in {}, which an Add does not write", unset.join(", "), emit.schema))
}

struct Built {
    object: u32,
    placement: u32,
    new_type: Option<u32>,
    new_context: Option<u32>,
}

#[path = "add_check.rs"]
mod check;

#[cfg(test)]
#[path = "add_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "add_refusal_tests.rs"]
mod refusal_tests;
