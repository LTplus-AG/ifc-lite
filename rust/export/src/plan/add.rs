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

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::step_text::escape;
use crate::step_ids::IdAllocator;

use super::add_geometry::product_shape;
use super::add_props::build_sets;
use super::add_rels::{RelAccumulator, RelKind, RelRequest};
use super::add_types::{AddItem, NewObject, Representation, TypeLink};
use super::attrs::unset_required;
use super::attribution::{Histories, Snapshot};
use super::index::FileIndex;
use super::placement::fmt;
use super::props_synth::{defines_by_properties_record, ref_or_unset};
use super::tessellation::{find_body_context, Emit};
use super::types::{ObjectRef, Refusal, ValidationFinding};

use assoc::{associate, Shared, SharedKey};
use mapped::{build_map, mapped_shape, MapPlan, MapRef, TypeMaps};
use units::build_units;
use check::Checked;

/// An object this plan added, as later Adds see it.
struct Added {
    id: u32,
    class: String,
}

pub(crate) struct AddState<'a, 'h> {
    index: &'a FileIndex<'a>,
    schema: &'a str,
    removed: &'a HashSet<u32>,
    history: &'a mut Histories<'h>,
    added: HashMap<String, Added>,
    /// Each added object's placement, by id, for children placed under it.
    placement_of_added: HashMap<u32, Option<u32>>,
    body_context: Option<u32>,
    rels: RelAccumulator<'a>,
    records: Vec<(u32, String)>,
    /// New materials, classifications and units the built Adds wrote, by
    /// description, for later Adds to reuse.
    shared: HashMap<SharedKey, u32>,
    /// The `Body` maps of each type an occurrence named or this plan added,
    /// once looked up.
    type_maps: RefCell<HashMap<u32, TypeMaps>>,
    /// Things a built Add did not do that its caller may expect, for the
    /// report's findings. Dropped with the Adds when their relationships fail.
    notes: Vec<ValidationFinding>,
    /// Types an occurrence of this plan is typed by, which settles a note
    /// about a type with nothing tying it to the file.
    typed: HashSet<u32>,
}

impl<'a, 'h> AddState<'a, 'h> {
    /// `history` is where new records' owner history comes from: the one the
    /// source (or a patch) already provides, else one the first Add that
    /// builds makes, so a plan whose Adds are all refused writes nothing.
    /// `body_context` is the one this plan's geometry patches already wrote
    /// into, if any; otherwise the file's own is looked up, and one is
    /// synthesized only when there is none.
    pub(crate) fn new(
        index: &'a FileIndex<'a>,
        schema: &'a str,
        removed: &'a HashSet<u32>,
        history: &'a mut Histories<'h>,
        body_context: Option<u32>,
    ) -> Self {
        Self {
            index,
            schema,
            removed,
            history,
            added: HashMap::new(),
            placement_of_added: HashMap::new(),
            body_context: body_context.or_else(|| find_body_context(index, schema, removed)),
            rels: RelAccumulator::new(index, removed),
            records: Vec::new(),
            shared: HashMap::new(),
            type_maps: RefCell::new(HashMap::new()),
            notes: Vec::new(),
            typed: HashSet::new(),
        }
    }

    /// Build one object, or refuse it whole.
    fn add(&mut self, key: &ObjectRef, obj: &NewObject, ids: &mut IdAllocator) -> Result<(), String> {
        let checked = self.check(key, obj)?;
        let mut out = Vec::new();
        let owner = self.owner_history_for(ids, &mut out)?;
        let mut requests = Vec::new();
        let mut emit = Emit { schema: self.schema, ids, out: &mut out };
        let built = self.build(&mut emit, obj, &checked, owner.id, &mut requests)?;
        let new_context = self.owned_context(built.new_context)?;

        self.typed.extend(checked.existing_type);
        self.commit(owner, out, built.shared);
        for req in requests {
            self.rels.relate(self.schema, req);
        }
        if let Some((context, owner)) = new_context {
            self.adopt_context(context, owner);
        }
        let gid = obj.global_id;
        self.placement_of_added.insert(built.object, Some(built.placement));
        self.added.insert(gid.encode(), Added { id: built.object, class: checked.class });
        if let (Some(type_id), Some((class, _, _)), Some(TypeLink::New(t))) = (built.new_type, checked.new_type, &obj.type_link) {
            self.register_type(type_id, t.global_id_for(gid), class, built.type_maps);
        }
        Ok(())
    }

    /// Build every Add, returning how many were written. The relationships of
    /// every Add are written together, all or nothing: when `finish` fails (the
    /// id space runs out, or a list it extends does not scan), it discards every
    /// built object's records along with them (see its doc comment), so each Add
    /// that had built is refused too, and `history` goes back to what it had
    /// committed before the Adds.
    pub(crate) fn build_all(
        mut self,
        adds: &[(&ObjectRef, AddItem)],
        ids: &mut IdAllocator,
        edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
        appended: &mut Vec<(u32, String)>,
        refusals: &mut Vec<Refusal>,
        findings: &mut Vec<ValidationFinding>,
    ) -> usize {
        let snapshot = self.history.snapshot();
        let mut built = Vec::new();
        for &(key, item) in adds {
            // A refused Add gives back the ids it took, so it changes no
            // later Add's ids or headroom.
            let before = *ids;
            let result = match item {
                AddItem::Object(new) => self.add(key, new, ids),
                AddItem::Type(t) => self.add_type(key, t, ids),
            };
            match result {
                Ok(()) => built.push(key),
                Err(reason) => {
                    *ids = before;
                    refusals.push(Refusal { object: key.clone(), reason });
                }
            }
        }
        let typed = std::mem::take(&mut self.typed);
        let mut notes = std::mem::take(&mut self.notes);
        notes.retain(|n| n.express_id.is_none_or(|id| !typed.contains(&id)));
        match self.finish(ids, edits_by_id, snapshot) {
            Ok(records) => {
                appended.extend(records);
                findings.append(&mut notes);
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

    /// Every record and list edit the Adds produced, relationships last. On
    /// failure nothing they took from `history` stays committed.
    fn finish(
        self,
        ids: &mut IdAllocator,
        edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
        snapshot: Snapshot,
    ) -> Result<Vec<(u32, String)>, String> {
        let owner_history = self.settled_history();
        let mut records = self.records;
        match self.rels.finish(self.schema, ids, owner_history, edits_by_id) {
            Ok(rels) => {
                records.extend(rels);
                Ok(records)
            }
            Err(reason) => {
                self.history.restore(snapshot);
                Err(reason)
            }
        }
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

        let a2p = emit.axis_placement(&obj.placement.matrix)?;
        let placement = emit.record(
            "IFCLOCALPLACEMENT",
            &[("PlacementRelTo", ref_or_unset(c.parent_placement)), ("RelativePlacement", format!("#{a2p}"))],
        )?;

        let new_type = match &obj.type_link {
            Some(TypeLink::New(t)) => Some(t),
            _ => None,
        };
        let type_rep = new_type.map(|t| &t.representation).filter(|r| !matches!(r, Representation::None));
        // A mapped body of an existing type is in its maps' contexts.
        let own_geometry = !matches!(obj.representation, Representation::None | Representation::Mapped(_));
        let needs_context = own_geometry || c.host.is_some() || type_rep.is_some();
        let (context, new_context) = match needs_context {
            false => (None, None),
            true => self.body_context_or_new(emit).map(|(c, new)| (Some(c), new))?,
        };
        // A new type's map comes first: the occurrence may instance it.
        let type_maps: Vec<MapRef> = match (type_rep, context, new_type) {
            (Some(rep), Some(ctx), Some(t)) => build_map(emit, ctx, rep, t.style.as_ref())?,
            _ => Vec::new(),
        };
        let mut shared = Shared { committed: &self.shared, pending: HashMap::new() };
        let shape = match (&obj.representation, context) {
            (Representation::Mapped(m), _) => {
                let maps: &[MapRef] = match &c.mapped {
                    Some(MapPlan::Existing(maps)) => maps,
                    Some(MapPlan::NewType) => &type_maps,
                    None => return Err("a mapped body was not checked".into()),
                };
                Some(mapped_shape(emit, &mut shared, maps, &m.transform)?)
            }
            (rep, Some(ctx)) => product_shape(emit, ctx, rep, obj.style.as_ref())?,
            (_, None) => None,
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
        if let Some(e) = obj.elevation {
            fields.push(("Elevation", fmt(e)));
        }
        let object = emit.record(&c.class, &fields)?;
        require_filled(emit, object)?;

        let units = build_units(emit, &mut shared, &c.units)?;
        let set_ids = build_sets(emit, owner_history, gid, "pset", &obj.psets, &units)?;
        for (set, spec) in set_ids.iter().zip(&obj.psets) {
            let id = emit.ids.allocate().ok_or("id space exhausted")?;
            let rel_guid = gid.derive(&format!("rel/pset/{}", spec.name)).encode();
            emit.out.push((id, defines_by_properties_record(self.schema, id, &rel_guid, owner_history, &[object], *set)));
        }

        let new_type = match (&obj.type_link, &c.new_type) {
            (Some(TypeLink::New(t)), Some((class, predefined, units))) => {
                let units = build_units(emit, &mut shared, units)?;
                Some(build_new_type(emit, t, gid, (class, predefined), &units, &type_maps, owner_history)?)
            }
            _ => None,
        };
        let type_target = new_type.or(c.existing_type);
        if let Some(t) = type_target {
            requests.push(RelRequest { kind: RelKind::DefinesByType, relating: t, related: object, seed: gid });
        }
        if let Some((container, kind)) = c.container {
            requests.push(RelRequest { kind, relating: container, related: object, seed: gid });
        }
        associate(emit, &mut shared, c, object, gid, requests)?;

        if let (Some(host), Some(op), Some(ctx)) = (c.host, &obj.opening, context) {
            self.build_opening(emit, gid, host, op, ctx, placement, (object, c.fills), &owh)?;
        }

        Ok(Built { object, placement, new_type, new_context, shared: shared.pending, type_maps })
    }

}

/// Refuse a record the build left without a value its schema requires,
/// such as an `IfcGrid`'s axes: an Add writes only the attributes common to
/// the products it supports.
pub(super) fn require_filled(emit: &Emit, id: u32) -> Result<(), String> {
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
    shared: HashMap<SharedKey, u32>,
    /// The maps of the new type it built, for later occurrences of it.
    type_maps: Vec<MapRef>,
}

#[path = "add_check.rs"]
mod check;

#[path = "add_assoc.rs"]
mod assoc;

#[path = "add_units.rs"]
mod units;

#[path = "add_commit.rs"]
mod commit;

#[path = "add_opening.rs"]
mod opening;

#[path = "add_mapped.rs"]
mod mapped;

#[path = "add_type.rs"]
mod standalone_type;
use standalone_type::build_new_type;

#[cfg(test)]
#[path = "add_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "add_refusal_tests.rs"]
mod refusal_tests;

#[cfg(test)]
#[path = "add_assoc_tests.rs"]
mod assoc_tests;
