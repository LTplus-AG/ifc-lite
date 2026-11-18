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
use std::collections::{BTreeSet, HashMap, HashSet};
use crate::schema_ifc2x3_records::ref_id;
use crate::schema_structural_axes::list_items;
use crate::step_record_frame::record_frame;
use crate::step_slot::split_top_level_args;

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
}

#[derive(Default)]
pub(crate) struct StructuralCarriers {
    /// Upgrade: action id -> its carried CausedBy.
    causes: HashMap<u32, Cause>,
    /// Upgrade: varying actions that stay unconverted although their CausedBy names a point reaction.
    unconverted: HashSet<u32>,
    /// Upgrade: the relationships written, in id order.
    pending: Vec<String>,
    /// Downgrade: action id -> the one point reaction that causes it.
    caused_by: HashMap<u32, u32>,
}

/// The source records the carriers read, from one pass.
#[derive(Default)]
struct Source {
    /// Type of every structural record, for subtype tests.
    types: HashMap<u32, String>,
    actions: Vec<(u32, String, Vec<String>)>,
    relationships: Vec<Vec<String>>,
}

impl Source {
    fn scan(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let mut source = Self::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            let structural = ty.get(..13).is_some_and(|p| p.eq_ignore_ascii_case("IFCSTRUCTURAL"));
            let relationship = ty.eq_ignore_ascii_case("IFCRELASSIGNSTOPRODUCT");
            if !(structural || relationship) || !kept(id, start) { continue; }
            let ty = ty.to_ascii_uppercase();
            let action = IFC2X3_ACTIONS.contains(&ty.as_str());
            if action || relationship {
                let text = String::from_utf8_lossy(&content[start..end]);
                let Some(args) = record_frame(&text).and_then(|f| split_top_level_args(f.args(&text))) else { continue };
                if relationship { source.relationships.push(args); } else { source.actions.push((id, ty.clone(), args)); }
            }
            if structural { source.types.insert(id, ty); }
        }
        source
    }

    /// Action id -> the reactions 'Causes' relationships name for it.
    fn causes(&self, schema: ifc_lite_core::SchemaVersion) -> HashMap<u32, BTreeSet<u32>> {
        let is = |id: u32, parent: &str| self.types.get(&id).is_some_and(|t| schema.is_subtype_of(t, parent));
        let mut causes: HashMap<u32, BTreeSet<u32>> = HashMap::new();
        for args in &self.relationships {
            if args.len() != 7 || args[2].trim() != "'Causes'" { continue; }
            let Some(action) = ref_id(Some(&args[6])).filter(|&a| is(a, "IfcStructuralAction")) else { continue };
            for reaction in list_items(&args[4]).unwrap_or_default().iter().filter_map(|r| ref_id(Some(r))) {
                if is(reaction, "IfcStructuralReaction") { causes.entry(action).or_default().insert(reaction); }
            }
        }
        causes
    }
}

impl StructuralCarriers {
    /// IFC2X3 -> IFC4: the CausedBy each action keeps as a 'Causes' relationship.
    /// `converts` says whether a varying action becomes an IFC4 action; one that
    /// stays IFC2X3 is no IFC4 product a relationship could name. Ids come from
    /// [`Self::allocate`].
    pub(crate) fn scan_ifc2x3(content: &[u8], kept: impl Fn(u32, usize) -> bool, converts: impl Fn(u32) -> bool) -> Self {
        let source = Source::scan(content, kept);
        let written = source.causes(ifc_lite_core::SchemaVersion::Ifc2x3);
        let mut result = Self::default();
        for (id, ty, args) in &source.actions {
            // IFC2X3 has only point reactions.
            let Some(reaction) = args.get(CAUSED_BY).and_then(|a| ref_id(Some(a))).filter(|r| source.types.get(r).is_some_and(|t| t == "IFCSTRUCTURALPOINTREACTION")) else { continue };
            if ty.ends_with("VARYING") && !converts(*id) { result.unconverted.insert(*id); continue; }
            let named = written.get(id);
            let new = !named.is_some_and(|n| n.contains(&reaction));
            let relationship = new.then(|| {
                let guid = crate::merged::deterministic_global_id(&format!("ifc2x3-caused-by:{}:#{reaction}", args[0].trim()));
                format!("IFCRELASSIGNSTOPRODUCT('{guid}',{},'Causes',$,(#{reaction}),$,#{id})", args[1])
            });
            // The downgrade restores CausedBy only for an action with exactly one cause.
            let total = named.map_or(0, BTreeSet::len) + usize::from(new);
            result.causes.insert(*id, Cause { relationship, message: if total == 1 { CAUSED_BY_WRITTEN } else { CAUSED_BY_AMONG } });
        }
        result
    }

    /// IFC4 -> IFC2X3: the actions one 'Causes' relationship names one point reaction for.
    pub(crate) fn scan_ifc4(content: &[u8], kept: impl Fn(u32, usize) -> bool) -> Self {
        let source = Source::scan(content, kept);
        let mut result = Self::default();
        for (action, reactions) in source.causes(ifc_lite_core::SchemaVersion::Ifc4) {
            let only = *reactions.first().expect("a cause names a reaction");
            if reactions.len() == 1 && source.types.get(&only).is_some_and(|t| t == "IFCSTRUCTURALPOINTREACTION") { result.caused_by.insert(action, only); }
        }
        result
    }

    /// The actions that need a relationship id, in id order.
    pub(crate) fn needs_ids(&self) -> impl Iterator<Item = u32> + '_ {
        let mut ids: Vec<u32> = self.causes.iter().filter(|(_, c)| c.relationship.is_some()).map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.into_iter()
    }

    /// Write the relationship of `action` under `id`.
    pub(crate) fn assign(&mut self, action: u32, id: u32) {
        if let Some(body) = self.causes.get(&action).and_then(|c| c.relationship.as_deref()) { self.pending.push(format!("#{id}={body};")); }
    }

    /// The message for an action whose CausedBy IFC4 holds, or None.
    pub(crate) fn cause(&self, id: u32) -> Option<&'static str> { self.causes.get(&id).map(|c| c.message) }

    /// Whether this is a varying action whose CausedBy stays only in its IFC2X3 record.
    pub(crate) fn stays_unconverted(&self, id: u32) -> bool { self.unconverted.contains(&id) }

    /// IFC4 -> IFC2X3: record `id`, already converted to `line`, with CausedBy
    /// filled from its one 'Causes' relationship. None when nothing changes.
    pub(crate) fn after(&self, id: u32, line: &str) -> Option<String> {
        let reaction = self.caused_by.get(&id)?;
        let frame = record_frame(line)?;
        if !IFC2X3_ACTIONS.contains(&frame.head.type_name(line)) { return None; }
        let mut args = split_top_level_args(frame.args(line))?;
        if args.get(CAUSED_BY)?.trim() != "$" { return None; }
        args[CAUSED_BY] = format!("#{reaction}");
        Some(frame.with_args(line, &args.join(",")))
    }

    /// The relationships written, to append after the source records.
    pub(crate) fn added(&mut self) -> Vec<String> { std::mem::take(&mut self.pending) }
}

#[cfg(test)]
#[path = "schema_structural_carriers_tests.rs"]
mod tests;
