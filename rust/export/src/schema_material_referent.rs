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
//! writes, by id in the export's id space ([`MaterialReferents::load_model`],
//! [`MaterialReferents::with_effective`]). Twin of
//! `packages/export/src/schema-converter-material-referent.ts`.
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::{slot_ref, slot_unset};
use crate::step_record_frame::record_frame;
use crate::step_slot::slots_of;
use crate::step_text::{apply_attr_mutations_counted, merge_edits};

const MATERIAL: &str = "IFCMATERIAL";
const PROPERTIES: &str = "IFCMATERIALPROPERTIES";
/// The member lists of the IFC4 material sets.
const MEMBERS: [&str; 3] = ["MaterialLayers", "MaterialProfiles", "MaterialConstituents"];

/// What a downgrade to IFC2X3 needs to know of the export's material records.
/// Built only by [`MaterialReferents::scan`] (one source) or
/// [`MaterialReferents::for_target`] plus [`MaterialReferents::load_model`]
/// (a merge), so a converter cannot hold one that silently checks nothing.
#[cfg_attr(test, derive(Default))]
pub(crate) struct MaterialReferents {
    /// The export downgrades to IFC2X3, the one target with a narrower `Material`.
    armed: bool,
    records: HashMap<u32, String>,
    /// Material records the export does not write (deleted, filtered out). A record retyped away but
    /// still written is not one: it is in neither map, so a set naming it names no material.
    gone: HashSet<u32>,
    /// Record id -> the type its `Material` names, for records not written.
    dropped: BTreeMap<u32, String>,
    ifc5_omitted: BTreeSet<u32>,
}

/// Whether `line` is a material record (IFCMATERIAL*), read from its head alone.
fn is_material(line: &str) -> bool {
    crate::step_record_frame::record_head(line).is_some_and(|h| h.type_name(line).get(..MATERIAL.len()).is_some_and(|p| p.eq_ignore_ascii_case(MATERIAL)))
}

/// The IFC4-family schema a material record of `from` is read in, or `None`.
fn ifc4_family(from: &str) -> Option<&'static str> {
    match from { "IFC4" => Some("IFC4"), "IFC4X3" => Some("IFC4X3"), _ => None }
}

fn record(text: &str) -> Option<(&str, Vec<&str>)> {
    let frame = record_frame(text)?;
    Some((frame.head.type_name(text), slots_of(frame.args(text))?))
}

/// The IfcMaterial `id` resolves to, or `None`; a set member in `gone` (not
/// written) is left out of the set, as the writers leave it out of the list.
fn resolve(records: &HashMap<u32, String>, gone: &HashSet<u32>, schema: &str, id: u32) -> Option<u32> {
    let (ty, slots) = record(records.get(&id)?)?;
    if ty.eq_ignore_ascii_case(MATERIAL) { return Some(id); }
    let names = crate::schema_convert::schema_attribute_names(schema, ty)?;
    let material = |slot: &str| {
        let id = slot_ref(slot)?;
        let (ty, _) = record(records.get(&id)?)?;
        ty.eq_ignore_ascii_case(MATERIAL).then_some(id)
    };
    if let Some(at) = names.iter().position(|n| *n == "Material") {
        return material(slots.get(at)?);
    }
    let at = names.iter().position(|n| MEMBERS.contains(n))?;
    let mut found = None;
    for member in list_items(slots.get(at)?)? {
        let member = slot_ref(&member)?;
        if gone.contains(&member) { continue; }
        let (ty, member_slots) = record(records.get(&member)?)?;
        let at = crate::schema_convert::schema_attribute_names(schema, ty)?.iter().position(|n| *n == "Material")?;
        let slot = *member_slots.get(at)?;
        // A member without a material (an air gap) names none.
        if slot_unset(slot) { continue; }
        let id = material(slot)?;
        if found.is_some_and(|previous| previous != id) { return None; }
        found = Some(id);
    }
    found
}

impl MaterialReferents {
    /// The schema a `from` record is read in, when this export downgrades it.
    fn schema_for(&self, from: &str) -> Option<&'static str> {
        ifc4_family(from).filter(|_| self.armed)
    }

    /// For an export to `to` (canonical), with no records yet.
    pub(crate) fn for_target(to: &str) -> Self {
        Self { armed: to == "IFC2X3", records: HashMap::new(), gone: Default::default(), dropped: BTreeMap::new(), ifc5_omitted: BTreeSet::new() }
    }

    /// One source converted from `from` to `to`, with its `kept` material records.
    /// `edited`: the export may create or edit material records (a mutation
    /// log), so any material record is read, not only a file holding properties.
    pub(crate) fn scan(content: &[u8], from: &str, to: &str, edited: bool, kept: &dyn Fn(u32, usize) -> bool) -> Self {
        let mut out = Self::for_target(to);
        out.load_model(content, from, if edited { MATERIAL } else { PROPERTIES }, &|id, start| kept(id, start).then_some((id, true)), &|bytes| String::from_utf8_lossy(bytes).into_owned());
        out
    }

    /// Loads the model's material records: `id_of` gives a record's id in the
    /// export and whether the export writes it. Earlier duplicate occurrences
    /// return `None`. `text_of` gives the text in the export's id space.
    /// `gate`: a type a model must hold to be scanned (a merge needs IFCMATERIALPROPERTIES;
    /// a single export, whose log may create one, any IFCMATERIAL record).
    #[inline(never)]
    pub(crate) fn load_model(&mut self, content: &[u8], from: &str, gate: &str, id_of: &dyn Fn(u32, usize) -> Option<(u32, bool)>, text_of: &dyn Fn(&[u8]) -> String) {
        // A filtered-out ID can overlap a later model's output range.
        // Keep referents local to the model being emitted and accumulate its warnings.
        self.records.clear();
        self.gone.clear();
        if self.schema_for(from).is_none() { return; }
        // A file without a record of `gate` needs no pass.
        if !content.windows(gate.len()).any(|w| w.eq_ignore_ascii_case(gate.as_bytes())) { return; }
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if !ty.get(..MATERIAL.len()).is_some_and(|p| p.eq_ignore_ascii_case(MATERIAL)) { continue; }
            let Some((id, written)) = id_of(id, start) else { continue };
            // A record the export does not write is left out of a set that lists it.
            if !written { self.gone.insert(id); continue; }
            self.records.insert(id, text_of(&content[start..end]));
        }
    }

    /// The material records as the export writes them: those `keep` refuses go
    /// (a set's member among them is left out of the set, as the writers leave
    /// it out of the list), and each of `lines` (an edited, copied or created
    /// record, as written, in `from`) replaces its record or, no longer a
    /// material (a retype), leaves the table.
    pub(crate) fn with_effective<'l>(&mut self, from: &str, keep: &dyn Fn(u32) -> bool, lines: impl IntoIterator<Item = (u32, &'l str)>) {
        if self.schema_for(from).is_none() { return; }
        self.retain_written(keep);
        for (id, line) in lines {
            // Typed from the head first: most edited records are not materials.
            if !is_material(line) && !self.records.contains_key(&id) { continue; }
            self.replace_record(id, Cow::Borrowed(line), keep(id));
        }
    }

    #[inline(never)]
    fn retain_written(&mut self, keep: &dyn Fn(u32) -> bool) {
        self.records.retain(|id, _| {
            if keep(*id) { return true; }
            self.gone.insert(*id);
            false
        });
    }

    #[inline(never)]
    fn replace_record(&mut self, id: u32, line: Cow<'_, str>, written: bool) {
        if written {
            self.gone.remove(&id);
            if is_material(&line) {
                self.records.insert(id, line.into_owned());
                return;
            }
        } else {
            self.gone.insert(id);
        }
        self.records.remove(&id);
    }

    /// Material edits and copies visible to the direct STEP writer.
    #[inline(never)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn note_step(
        &mut self,
        from: &str,
        content: &[u8],
        spans: &HashMap<u32, (usize, usize)>,
        included: &HashSet<u32>,
        muts: &HashMap<u32, BTreeMap<usize, String>>,
        repointed: &HashMap<u32, BTreeMap<usize, String>>,
        copies: &[crate::step_cow::Copy],
    ) {
        if self.schema_for(from).is_none() { return; }
        self.retain_written(&|id| included.contains(&id));
        let material = |id: &u32| {
            let &(start, end) = spans.get(id)?;
            let text = String::from_utf8_lossy(&content[start..end]);
            is_material(&text).then_some(text)
        };
        for id in muts.keys().chain(repointed.keys().filter(|id| !muts.contains_key(id))) {
            let Some(line) = material(id) else { continue };
            let Some(edits) = merge_edits(muts.get(id), repointed.get(id)) else { continue };
            self.replace_record(*id, apply_attr_mutations_counted(&line, &edits, &mut 0).into(), included.contains(id));
        }
        for (copy, source, edits) in copies {
            let Some(line) = material(source) else { continue };
            self.replace_record(*copy, crate::step_cow::apply_copy_edits(&line, muts.get(source), edits, &mut 0).into(), true);
        }
    }

    /// `line`, record `id` in `from` before conversion, naming the material its
    /// `Material` resolves to; `None` when it names none, adding its values to `dropped`.
    #[inline(never)]
    pub(crate) fn apply<'l>(&mut self, id: u32, line: &'l str, from: &str, dropped: &mut usize) -> Option<Cow<'l, str>> {
        let schema = self.schema_for(from);
        let omit_ifc5 = self.armed && from == "IFC5";
        if schema.is_none() && !omit_ifc5 { return Some(line.into()); }
        // The head names the type; most records stop before their slots are split.
        let Some(head) = crate::step_record_frame::record_head(line) else { return Some(line.into()) };
        if !head.type_name(line).eq_ignore_ascii_case(PROPERTIES) { return Some(line.into()); }
        let layout = schema.and_then(|schema| {
            let names = crate::schema_convert::schema_attribute_names(schema, PROPERTIES)?;
            names.iter().position(|name| *name == "Material").map(|at| (schema, at))
        });
        if layout.is_none() && !omit_ifc5 { return Some(line.into()); }
        // The line converter also accepts a record without its terminating semicolon.
        let padded;
        let (text, frame) = if let Some(frame) = record_frame(line) {
            (line, Some(frame))
        } else {
            padded = format!("{line};");
            (padded.as_str(), record_frame(&padded))
        };
        let parsed = frame.and_then(|frame| slots_of(frame.args(text)).map(|slots| (frame, slots)));
        let populated = || parsed.as_ref().map_or(1, |(_, slots)| slots.iter().filter(|s| !slot_unset(s)).count());
        let Some((schema, at)) = layout else {
            *dropped += populated();
            self.ifc5_omitted.insert(id);
            return None;
        };
        let named = parsed.as_ref().and_then(|(_, slots)| slots.get(at)).and_then(|s| slot_ref(s));
        if let Some((reference, material)) = named.and_then(|r| resolve(&self.records, &self.gone, schema, r).map(|m| (r, m))) {
            if material == reference { return Some(line.into()); }
            let (frame, mut slots) = parsed?;
            let replacement = format!("#{material}");
            slots[at] = &replacement;
            let mut out = frame.with_args(text, &slots.join(","));
            if text.len() != line.len() { out.pop(); }
            return Some(out.into());
        }
        *dropped += populated();
        let why = match (&parsed, named) {
            (None, _) => "unreadable".to_owned(),
            (_, None) => "no Material".to_owned(),
            (_, Some(r)) => self.records.get(&r).and_then(|text| record(text))
                .map_or_else(|| "an unread record".to_owned(), |(ty, _)| ty.to_ascii_uppercase()),
        };
        self.dropped.insert(id, why);
        None
    }

    #[inline(never)]
    pub(crate) fn warnings(&self) -> Vec<String> {
        let mut warnings = Vec::new();
        if !self.dropped.is_empty() {
            let sites: Vec<String> = self.dropped.iter().map(|(id, ty)| format!("#{id} ({ty})")).collect();
            warnings.push(format!(
                "{} IfcMaterialProperties record(s) were not written: IFC2X3 IfcExtendedMaterialProperties.Material must name one IfcMaterial, and theirs does not: {} (#10763).",
                self.dropped.len(), sites.join(", ")
            ));
        }
        if !self.ifc5_omitted.is_empty() {
            let sites: Vec<String> = self.ifc5_omitted.iter().map(|id| format!("#{id}")).collect();
            warnings.push(format!(
                "{} IfcMaterialProperties record(s) were not written because IFC5 has no EXPRESS attribute registry: {} (#11132).",
                self.ifc5_omitted.len(), sites.join(", ")
            ));
        }
        warnings
    }
}

#[cfg(test)]
#[path = "schema_material_referent_tests.rs"]
mod tests;
