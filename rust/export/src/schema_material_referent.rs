// SPDX-License-Identifier: MPL-2.0
//! The `Material` a downgraded IfcMaterialProperties may name (#10763).
//!
//! IFC4 types `IfcMaterialProperties.Material` as any IfcMaterialDefinition
//! (a material, a layer, a layer/profile/constituent set or member); IFC2X3
//! `IfcExtendedMaterialProperties.Material` takes an IfcMaterial only. So the
//! downgrade cannot carry the reference by value:
//!  - an IfcMaterial is kept;
//!  - a definition whose `Material`, or whose members' `Material`, is exactly
//!    one IfcMaterial is pointed at that material;
//!  - anything else, the record is not written (`convert_step_line` returns
//!    an empty line, which every STEP writer skips), its values are counted
//!    dropped and the export names it.
//!
//! Resolved on the source-schema record, before conversion, so a reference
//! the converter would withhold (an IFC4-only set) is replaced first and a
//! record left out reaches no other counter. Attributes are found by name in
//! the record's own schema, so subtypes such as IfcMaterialLayerWithOffsets
//! resolve too. The record is read as the writer hands it over (edited,
//! copied, appended); its referents are the material records the export
//! writes, by id in the export's id space ([`MaterialReferents::add_model`],
//! [`MaterialReferents::with_effective`]). Twin of
//! `packages/export/src/schema-converter-material-referent.ts`.
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::{slot_ref, slot_unset};

const MATERIAL: &str = "IFCMATERIAL";
const PROPERTIES: &str = "IFCMATERIALPROPERTIES";
/// The member lists of the IFC4 material sets.
const MEMBERS: [&str; 3] = ["MaterialLayers", "MaterialProfiles", "MaterialConstituents"];

/// A material record the export writes: `(UPPERCASE type, slots, its schema)`.
type Record = (String, Vec<String>, &'static str);

/// What a downgrade to IFC2X3 needs to know of the export's material records.
/// Built only by [`MaterialReferents::scan`] (one source) or
/// [`MaterialReferents::for_target`] plus [`MaterialReferents::add_model`]
/// (a merge), so a converter cannot hold one that silently checks nothing.
#[cfg_attr(test, derive(Default))]
pub(crate) struct MaterialReferents {
    /// The export downgrades to IFC2X3, the one target with a narrower `Material`.
    armed: bool,
    records: HashMap<u32, Record>,
    /// Material records the export does not write (deleted, left out, retyped away).
    gone: std::collections::HashSet<u32>,
    /// Record id -> the type its `Material` names, for records not written.
    dropped: BTreeMap<u32, String>,
}

/// Whether `line` is a material record (IFCMATERIAL*), read from its head alone.
fn is_material(line: &str) -> bool {
    crate::step_record_frame::record_head(line).is_some_and(|h| h.type_name(line).get(..MATERIAL.len()).is_some_and(|p| p.eq_ignore_ascii_case(MATERIAL)))
}

/// The IFC4-family schema a material record of `from` is read in, or `None`.
fn ifc4_family(from: &str) -> Option<&'static str> {
    match from { "IFC4" => Some("IFC4"), "IFC4X3" => Some("IFC4X3"), _ => None }
}

/// The IfcMaterial `id` resolves to, or `None`; a set member in `gone` (not
/// written) is left out of the set, as the writers leave it out of the list.
fn resolve(records: &HashMap<u32, Record>, gone: &std::collections::HashSet<u32>, id: u32) -> Option<u32> {
    let (ty, slots, schema) = records.get(&id)?;
    if ty == MATERIAL { return Some(id); }
    let names = crate::schema_convert::schema_attribute_names(schema, ty)?;
    let material = |slot: &str| slot_ref(slot).filter(|m| records.get(m).is_some_and(|(t, ..)| t == MATERIAL));
    if let Some(at) = names.iter().position(|n| *n == "Material") {
        return material(slots.get(at)?);
    }
    let at = names.iter().position(|n| MEMBERS.contains(n))?;
    let mut found = BTreeSet::new();
    for member in list_items(slots.get(at)?)? {
        let member = slot_ref(&member)?;
        if gone.contains(&member) { continue; }
        let (ty, member_slots, schema) = records.get(&member)?;
        let at = crate::schema_convert::schema_attribute_names(schema, ty)?.iter().position(|n| *n == "Material")?;
        let slot = member_slots.get(at)?;
        // A member without a material (an air gap) names none.
        if slot_unset(slot) { continue; }
        found.insert(material(slot)?);
    }
    (found.len() == 1).then(|| found.into_iter().next()).flatten()
}

impl MaterialReferents {
    /// The schema a `from` record is read in, when this export downgrades it.
    fn schema_for(&self, from: &str) -> Option<&'static str> {
        ifc4_family(from).filter(|_| self.armed)
    }

    /// For an export to `to` (canonical), with no records yet: a merge adds each model's.
    pub(crate) fn for_target(to: &str) -> Self {
        Self { armed: to == "IFC2X3", records: HashMap::new(), gone: Default::default(), dropped: BTreeMap::new() }
    }

    /// One source converted from `from` to `to`, with its `kept` material records.
    /// `edited`: the export may create or edit material records (a mutation
    /// log), so any material record is read, not only a file holding properties.
    pub(crate) fn scan(content: &[u8], from: &str, to: &str, edited: bool, kept: &dyn Fn(u32, usize) -> bool) -> Self {
        let mut out = Self::for_target(to);
        out.add_model(content, from, if edited { MATERIAL } else { PROPERTIES }, &|id, start| (id, kept(id, start)), &|bytes| String::from_utf8_lossy(bytes).into_owned());
        out
    }

    /// Adds a model's material records: `id_of` gives a record's id in the
    /// export and whether the export writes it, `text_of` its text in the export's id space.
    /// `gate`: a type a model must hold to be scanned (a merge needs IFCMATERIALPROPERTIES;
    /// a single export, whose log may create one, any IFCMATERIAL record).
    pub(crate) fn add_model(&mut self, content: &[u8], from: &str, gate: &str, id_of: &dyn Fn(u32, usize) -> (u32, bool), text_of: &dyn Fn(&[u8]) -> String) {
        let Some(schema) = self.schema_for(from) else { return };
        // A file without a record of `gate` needs no pass.
        if !content.windows(gate.len()).any(|w| w.eq_ignore_ascii_case(gate.as_bytes())) { return; }
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if !ty.get(..MATERIAL.len()).is_some_and(|p| p.eq_ignore_ascii_case(MATERIAL)) { continue; }
            let (id, written) = id_of(id, start);
            // A record the export does not write is left out of a set that lists it.
            if !written { self.gone.insert(id); continue; }
            if let Some((ty, slots)) = crate::step_log::read_slots(&text_of(&content[start..end])) {
                self.records.insert(id, (ty, slots, schema));
            }
        }
        // A duplicate id the export leaves out does not hide the occurrence it keeps.
        self.gone.retain(|id| !self.records.contains_key(id));
    }

    /// The material records as the export writes them: those `keep` refuses go
    /// (a set's member among them is left out of the set, as the writers leave
    /// it out of the list), and each of `lines` (an edited, copied or created
    /// record, as written, in `from`) replaces its record or, no longer a
    /// material (a retype), leaves the table.
    pub(crate) fn with_effective<'l>(&mut self, from: &str, keep: impl Fn(u32) -> bool, lines: impl IntoIterator<Item = (u32, &'l str)>) {
        let Some(schema) = self.schema_for(from) else { return };
        let gone: Vec<u32> = self.records.keys().copied().filter(|id| !keep(*id)).collect();
        for id in gone { self.records.remove(&id); self.gone.insert(id); }
        for (id, line) in lines {
            // Typed from the head first: most edited records are not materials.
            if !is_material(line) && !self.records.contains_key(&id) { continue; }
            match crate::step_log::read_slots(line) {
                Some((ty, slots)) if keep(id) && ty.starts_with(MATERIAL) => { self.gone.remove(&id); self.records.insert(id, (ty, slots, schema)); }
                _ => { self.records.remove(&id); self.gone.insert(id); }
            }
        }
    }

    /// [`Self::with_effective`] for `step.rs`: the records as its emit loop
    /// writes them, attribute edits and copy-on-write repointings applied, and
    /// each copy under its own id.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn note_step(
        &mut self,
        from: &str,
        content: &[u8],
        spans: &HashMap<u32, (usize, usize)>,
        included: &std::collections::HashSet<u32>,
        muts: &HashMap<u32, BTreeMap<usize, String>>,
        repointed: &HashMap<u32, BTreeMap<usize, String>>,
        copies: &[crate::step_cow::Copy],
    ) {
        if self.schema_for(from).is_none() { return; }
        let material = |id: &u32| spans.get(id).map(|&(s, e)| String::from_utf8_lossy(&content[s..e])).filter(|l| is_material(l));
        let edited_ids: std::collections::HashSet<&u32> = muts.keys().chain(repointed.keys()).collect();
        let mut lines: Vec<(u32, String)> = edited_ids.into_iter().filter_map(|id| {
            Some((*id, crate::step_text::apply_attr_mutations_counted(&material(id)?, &*crate::step_text::merge_edits(muts.get(id), repointed.get(id))?, &mut 0)))
        }).collect();
        lines.extend(copies.iter().filter_map(|(copy, source, edits)| {
            let mut all = muts.get(source).cloned().unwrap_or_default();
            all.extend(edits.iter().map(|(i, v)| (*i, v.clone())));
            Some((*copy, crate::step_text::renumber(&crate::step_text::apply_attr_mutations_counted(&material(source)?, &all, &mut 0), *copy)))
        }));
        let copy_ids: std::collections::HashSet<u32> = copies.iter().map(|c| c.0).collect();
        self.with_effective(from, |id| included.contains(&id) || copy_ids.contains(&id), lines.iter().map(|(id, l)| (*id, l.as_str())));
    }

    /// `line`, record `id` in `from` before conversion, naming the material its
    /// `Material` resolves to; `None` when it names none, adding its values to `dropped`.
    pub(crate) fn apply<'l>(&mut self, id: u32, line: &'l str, from: &str, dropped: &mut usize) -> Option<Cow<'l, str>> {
        let Some(schema) = self.schema_for(from) else { return Some(line.into()) };
        // The head names the type; most records stop before their slots are split.
        let Some(head) = crate::step_record_frame::record_head(line) else { return Some(line.into()) };
        if !head.type_name(line).eq_ignore_ascii_case(PROPERTIES) { return Some(line.into()); }
        let Some(at) = crate::schema_convert::schema_attribute_names(schema, PROPERTIES).and_then(|n| n.iter().position(|a| *a == "Material")) else { return Some(line.into()) };
        // Read as written; `convert_record` also accepts a record without its ';', so failing that, with one added.
        // A record that cannot be read either way is not checked, so it is left out too.
        let mut framed = Cow::Borrowed(line);
        let mut slots = crate::step_log::read_slots(line).map(|(_, s)| s);
        if slots.is_none() {
            framed = format!("{line};").into();
            slots = crate::step_log::read_slots(&framed).map(|(_, s)| s);
        }
        let named = slots.as_ref().and_then(|s| s.get(at)).and_then(|s| slot_ref(s));
        let kept = match (named, named.and_then(|r| resolve(&self.records, &self.gone, r))) {
            (Some(r), Some(m)) if m != r => crate::step_log::replace_argument(&framed, at, &format!("#{m}")).map(|mut out| {
                if matches!(framed, Cow::Owned(_)) { out.pop(); } // the ';' it was read with is the last character
                Cow::Owned(out)
            }),
            (_, Some(_)) => Some(line.into()),
            _ => None,
        };
        if kept.is_none() {
            *dropped += slots.as_ref().map_or(1, |s| s.iter().filter(|s| !slot_unset(s)).count()); // unread: at least the record
            let named = named.and_then(|r| self.records.get(&r)).map_or("an unread record", |(t, ..)| t.as_str());
            self.dropped.insert(id, named.to_owned());
        }
        kept
    }

    pub(crate) fn warnings(&self) -> Vec<String> {
        if self.dropped.is_empty() { return Vec::new(); }
        let sites: Vec<String> = self.dropped.iter().map(|(id, ty)| format!("#{id} ({ty})")).collect();
        vec![format!(
            "{} IfcMaterialProperties record(s) were not written: IFC2X3 IfcExtendedMaterialProperties.Material must name one IfcMaterial, and theirs does not: {} (#10763).",
            self.dropped.len(),
            sites.join(", ")
        )]
    }
}

#[cfg(test)]
#[path = "schema_material_referent_tests.rs"]
mod tests;
