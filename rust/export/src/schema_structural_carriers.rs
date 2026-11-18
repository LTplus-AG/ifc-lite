// SPDX-License-Identifier: MPL-2.0
//! Structural values one of IFC2X3 and IFC4 holds in an attribute and the other
//! holds elsewhere (#9668). Twin of
//! `packages/export/src/schema-converter-structural-carriers.ts`; ported so far:
//!
//! - CausedBy. IFC4 deleted IfcStructuralAction.CausedBy; an action caused by a
//!   reaction is the RelatingProduct of an IfcRelAssignsToProduct named 'Causes'
//!   whose RelatedObjects is the reaction. The upgrade adds that relationship;
//!   the downgrade keeps it (IFC2X3 has the same entity) and fills CausedBy
//!   from it.
//!
//! Both directions read the source, so only an unedited full export arms them.
use std::collections::{BTreeMap, HashMap};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::{slot_is, slot_ref, slot_unset};
use crate::schema_structural_varying::record;
use crate::step_record_frame::record_frame;
use crate::step_slot::slots_of;

/// The IFC2X3 actions with a CausedBy slot (IFC2X3_TC1.exp:7237).
const IFC2X3_ACTIONS: [&str; 5] = ["IFCSTRUCTURALPOINTACTION", "IFCSTRUCTURALLINEARACTION", "IFCSTRUCTURALPLANARACTION", "IFCSTRUCTURALLINEARACTIONVARYING", "IFCSTRUCTURALPLANARACTIONVARYING"];
/// IfcStructuralAction.CausedBy in IFC2X3: slot 10 of every action.
const CAUSED_BY: usize = 10;

pub(crate) const CAUSED_BY_AMONG: &str = "IFC2X3 CausedBy is one of several reactions the action's 'Causes' relationships name in IFC4, so IFC2X3 CausedBy cannot be restored from them";
pub(crate) const CAUSED_BY_WRITTEN: &str = "IFC2X3 CausedBy is written as an IfcRelAssignsToProduct named 'Causes' from the action to the reaction, as IFC4 holds it";
pub(crate) const CAUSED_BY_READ: &str = "an IfcRelAssignsToProduct named 'Causes' from an action to one point reaction also fills the IFC2X3 CausedBy";
pub(crate) const CAUSED_BY_UNCONVERTED: &str = "IFC2X3 CausedBy of a varying action that stays unconverted is kept only in that IFC2X3 record; no 'Causes' relationship is written";

/// IFC2X3 -> IFC4: what one action's CausedBy becomes.
struct Cause {
    /// The 'Causes' relationship to add, without its id, unless a source one already names the reaction.
    relationship: Option<String>,
    message: &'static str,
    /// An IFC2X3 varying action, which only a converting `StructuralVarying` turns into an IFC4 product.
    varying: bool,
    /// The relationship's id, from [`StructuralCarriers::assign`].
    id: Option<u32>,
}

#[derive(Default)]
pub(crate) struct StructuralCarriers {
    /// Upgrade: action id -> its CausedBy, for each action whose CausedBy names a point reaction.
    causes: HashMap<u32, Cause>,
    /// Upgrade: the relationships written so far, by id (the TypeScript twin's allocation order).
    pending: BTreeMap<u32, String>,
    /// Downgrade: action id -> the one point reaction that causes it.
    caused_by: HashMap<u32, u32>,
}

/// The source records the carriers read, from one pass.
#[derive(Default)]
struct Source {
    /// Type of every structural record, for subtype tests.
    types: HashMap<u32, String>,
    /// IFC2X3 actions with their arguments; collected for the upgrade only.
    actions: Vec<(u32, String, Vec<String>)>,
    relationships: Vec<(u32, Vec<u32>)>,
}

impl Source {
    #[inline(never)]
    fn scan(content: &[u8], kept: &dyn Fn(u32, usize) -> bool, upgrade: bool) -> Self {
        let mut source = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            let structural = ty.get(..13).is_some_and(|p| p.eq_ignore_ascii_case("IFCSTRUCTURAL"));
            let relationship = ty.eq_ignore_ascii_case("IFCRELASSIGNSTOPRODUCT");
            if !(structural || relationship) || !kept(id, start) { continue; }
            let ty = ty.to_ascii_uppercase();
            let action = upgrade && IFC2X3_ACTIONS.contains(&ty.as_str());
            if relationship {
                let text = String::from_utf8_lossy(&content[start..end]);
                if let Some(cause) = read_relationship(&text) {
                    source.relationships.push(cause);
                }
            } else if action {
                let Some(args) = record(content, start, end) else { continue };
                source.actions.push((id, ty.clone(), args));
            }
            if structural { source.types.insert(id, ty); }
        }
        source
    }

    /// Action id -> distinct reactions named by its 'Causes' relationships.
    #[inline(never)]
    fn causes(&self, schema: ifc_lite_core::SchemaVersion) -> HashMap<u32, Vec<u32>> {
        let is = |id: u32, parent: &str| self.types.get(&id).is_some_and(|t| schema.is_subtype_of(t, parent));
        let mut causes: HashMap<u32, Vec<u32>> = HashMap::new();
        for (action, reactions) in &self.relationships {
            if !is(*action, "IfcStructuralAction") { continue; }
            for &reaction in reactions {
                if is(reaction, "IfcStructuralReaction") {
                    causes.entry(*action).or_default().push(reaction);
                }
            }
        }
        for reactions in causes.values_mut() {
            reactions.sort_unstable();
            reactions.dedup();
        }
        causes
    }
}

fn read_relationship(line: &str) -> Option<(u32, Vec<u32>)> {
    let args = slots_of(record_frame(line)?.args(line))?;
    let [_, _, name, _, objects, _, product] = args.as_slice() else { return None };
    if !slot_is(name, b"'Causes'") { return None; }
    let action = slot_ref(product)?;
    let mut reactions = Vec::new();
    for item in list_items(objects)? {
        if let Some(reaction) = slot_ref(&item) {
            reactions.push(reaction);
        }
    }
    Some((action, reactions))
}

impl StructuralCarriers {
    /// IFC2X3 -> IFC4: the CausedBy of each action that names a point reaction,
    /// as a 'Causes' relationship. Ids come from [`Self::assign`].
    pub(crate) fn scan_ifc2x3(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let source = Source::scan(content, &kept, true);
        let written = source.causes(ifc_lite_core::SchemaVersion::Ifc2x3);
        let mut result = Self::default();
        for (id, ty, args) in &source.actions {
            // IFC2X3 has only point reactions.
            let Some(reaction) = args.get(CAUSED_BY).and_then(|a| slot_ref(a)).filter(|r| source.types.get(r).is_some_and(|t| t == "IFCSTRUCTURALPOINTREACTION")) else { continue };
            let named = written.get(id);
            let new = named.is_none_or(|n| n.binary_search(&reaction).is_err());
            let relationship = new.then(|| {
                let guid = crate::merged::deterministic_global_id(&format!("ifc2x3-caused-by:{}:#{reaction}", args[0].trim()));
                format!("IFCRELASSIGNSTOPRODUCT('{guid}',{},'Causes',$,(#{reaction}),$,#{id})", args[1])
            });
            // The downgrade restores CausedBy only for an action with exactly one cause.
            let total = named.map_or(0, Vec::len) + usize::from(new);
            let message = if total == 1 { CAUSED_BY_WRITTEN } else { CAUSED_BY_AMONG };
            result.causes.insert(*id, Cause { relationship, message, varying: crate::schema_structural_varying::StructuralVarying::is_varying(ty), id: None });
        }
        result
    }

    /// IFC4 -> IFC2X3: the actions one 'Causes' relationship names one point reaction for.
    pub(crate) fn scan_ifc4(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let source = Source::scan(content, &kept, false);
        let mut result = Self::default();
        for (action, reactions) in source.causes(ifc_lite_core::SchemaVersion::Ifc4) {
            if reactions.len() != 1 { continue; }
            let only = reactions.first().copied();
            if let Some(only) = only.filter(|r| source.types.get(r).is_some_and(|t| t == "IFCSTRUCTURALPOINTREACTION")) { result.caused_by.insert(action, only); }
        }
        result
    }

    /// The actions that need a relationship id.
    pub(crate) fn needs_ids(&self) -> impl Iterator<Item = u32> + '_ {
        self.causes.iter().filter_map(|(&id, cause)| cause.relationship.as_ref().map(|_| id))
    }

    pub(crate) fn needs_id(&self, action: u32, configured: bool) -> bool {
        self.causes.get(&action).is_some_and(|cause| {
            cause.relationship.is_some() && (!cause.varying || configured)
        })
    }

    /// Give the relationship of `action` its id.
    pub(crate) fn assign(&mut self, action: u32, id: u32) {
        if let Some(cause) = self.causes.get_mut(&action) { cause.id = Some(id); }
    }

    /// Write the relationship of `action`, as the action itself is written.
    pub(crate) fn write(&mut self, action: u32) {
        if let Some(Cause { relationship: Some(body), id: Some(id), .. }) = self.causes.get(&action) { self.pending.insert(*id, format!("#{id}={body};")); }
    }

    /// Whether the action's CausedBy names a point reaction.
    pub(crate) fn names_reaction(&self, id: u32) -> bool { self.causes.contains_key(&id) }

    /// The message for an action whose CausedBy a 'Causes' relationship holds: one
    /// the source has, or one given an id. None otherwise, so the loss is reported.
    pub(crate) fn cause(&self, id: u32) -> Option<&'static str> {
        self.causes.get(&id).filter(|c| c.relationship.is_none() || c.id.is_some()).map(|c| c.message)
    }

    /// IFC4 -> IFC2X3: record `id`, already converted to `line`, with CausedBy
    /// filled from its one 'Causes' relationship. None when nothing changes.
    pub(crate) fn after(&self, id: u32, line: &str) -> Option<String> {
        let reaction = self.caused_by.get(&id)?;
        let frame = record_frame(line)?;
        if !IFC2X3_ACTIONS.contains(&frame.head.type_name(line)) { return None; }
        let args = slots_of(frame.args(line))?;
        let slot = *args.get(CAUSED_BY)?;
        if !slot_unset(slot) { return None; }
        let start = slot.as_ptr() as usize - line.as_ptr() as usize;
        let mut output = line.to_owned();
        output.replace_range(start..start + slot.len(), &format!("#{reaction}"));
        Some(output)
    }

    /// The relationships written, to append after the source records.
    pub(crate) fn added(&mut self) -> Vec<String> { std::mem::take(&mut self.pending).into_values().collect() }
}

#[cfg(test)]
#[path = "schema_structural_carriers_tests.rs"]
mod tests;
