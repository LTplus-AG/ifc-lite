// SPDX-License-Identifier: MPL-2.0
//! The `Material` a downgraded IfcMaterialProperties may name (#10763).
//!
//! IFC4 types `IfcMaterialProperties.Material` as any IfcMaterialDefinition
//! (a material, a layer, a layer/profile/constituent set or member); IFC2X3
//! `IfcExtendedMaterialProperties.Material` takes an IfcMaterial only. So the
//! downgrade cannot carry the reference by value. From the source records:
//!  - an IfcMaterial is kept;
//!  - a definition whose `Material`, or whose members' `Material`, is exactly
//!    one IfcMaterial is pointed at that material;
//!  - anything else, the record is not written (`apply` returns an empty
//!    line, which both STEP writers skip), its values are counted dropped and
//!    the export names it.
//!
//! Attributes are found by name in the source schema, so subtypes such as
//! IfcMaterialLayerWithOffsets resolve too. The record is read as converted,
//! so an edited or appended record is checked as written; its referents are
//! the material records as the export writes them ([`MaterialReferents::with_effective`]),
//! so one it leaves out resolves to nothing. Twin of
//! `packages/export/src/schema-converter-material-referent.ts`.
use std::collections::{BTreeMap, BTreeSet, HashMap};
use crate::schema_structural_axes::list_items;
use crate::schema_structural_links::{slot_ref, slot_unset};

const MATERIAL: &str = "IFCMATERIAL";
/// What IFCMATERIALPROPERTIES is written as in IFC2X3.
const WRITTEN_AS: &str = "IFCEXTENDEDMATERIALPROPERTIES";
/// The member lists of the IFC4 material sets.
const MEMBERS: [&str; 3] = ["MaterialLayers", "MaterialProfiles", "MaterialConstituents"];

/// The kept source's material records, by id: `(UPPERCASE type, slots)`.
type Records = HashMap<u32, (String, Vec<String>)>;

#[derive(Default)]
pub(crate) struct MaterialReferents {
    /// The source schema, once armed.
    from: Option<&'static str>,
    records: Records,
    /// Record id -> the type its `Material` names, for records not written.
    dropped: BTreeMap<u32, String>,
}

/// Whether `line` is a material record (IFCMATERIAL*), read from its head alone.
pub(crate) fn is_material(line: &str) -> bool {
    crate::step_record_frame::record_head(line).is_some_and(|h| h.type_name(line).get(..MATERIAL.len()).is_some_and(|p| p.eq_ignore_ascii_case(MATERIAL)))
}

/// The IfcMaterial `id` resolves to in `from`, or `None`.
fn resolve(records: &Records, from: &str, id: u32) -> Option<u32> {
    let (ty, slots) = records.get(&id)?;
    if ty == MATERIAL { return Some(id); }
    let names = crate::schema_convert::schema_attribute_names(from, ty)?;
    let material = |slot: &str| slot_ref(slot).filter(|m| records.get(m).is_some_and(|(t, _)| t == MATERIAL));
    if let Some(at) = names.iter().position(|n| *n == "Material") {
        return material(slots.get(at)?);
    }
    let at = names.iter().position(|n| MEMBERS.contains(n))?;
    let mut found = BTreeSet::new();
    for member in list_items(slots.get(at)?)? {
        let (ty, member_slots) = records.get(&slot_ref(&member)?)?;
        let at = crate::schema_convert::schema_attribute_names(from, ty)?.iter().position(|n| *n == "Material")?;
        let slot = member_slots.get(at)?;
        // A member without a material (an air gap) names none.
        if slot_unset(slot) { continue; }
        found.insert(material(slot)?);
    }
    (found.len() == 1).then(|| found.into_iter().next()).flatten()
}

impl MaterialReferents {
    /// Arms an IFC4/IFC4X3 source converted to IFC2X3 with its `kept` material records.
    pub(crate) fn scan(content: &[u8], from: &str, to: &str, kept: &dyn Fn(u32, usize) -> bool) -> Self {
        let from: &'static str = match (from, to) {
            ("IFC4", "IFC2X3") => "IFC4",
            ("IFC4X3", "IFC2X3") => "IFC4X3",
            _ => return Self::default(),
        };
        let mut out = Self { from: Some(from), ..Self::default() };
        // A file without a material record needs no pass (a created one arrives through `with_effective`).
        if !content.windows(MATERIAL.len()).any(|w| w.eq_ignore_ascii_case(MATERIAL.as_bytes())) { return out; }
        let mut scanner = ifc_lite_core::EntityScanner::new(content);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if !ty.get(..MATERIAL.len()).is_some_and(|p| p.eq_ignore_ascii_case(MATERIAL)) || !kept(id, start) { continue; }
            if let Some(record) = crate::step_log::read_slots(&String::from_utf8_lossy(&content[start..end])) {
                out.records.insert(id, record);
            }
        }
        out
    }

    /// The material records as the export writes them: those `keep` refuses go;
    /// each `edited` line (a source record or a copy, as written) replaces its
    /// record; a `created` record counts only as an IfcMaterial, which is what
    /// TypeScript can read of one (its type, no source slots).
    pub(crate) fn with_effective(
        &mut self,
        keep: impl Fn(u32) -> bool,
        edited: impl IntoIterator<Item = (u32, String)>,
        created: impl IntoIterator<Item = (u32, String)>,
    ) {
        if self.from.is_none() { return; }
        self.records.retain(|id, _| keep(*id));
        // `material_only`: a created record counts only as an IfcMaterial.
        let mut put = |id: u32, line: &str, material_only: bool| match crate::step_log::read_slots(line) {
            Some(record) if keep(id) && (if material_only { record.0 == MATERIAL } else { record.0.starts_with(MATERIAL) }) => drop(self.records.insert(id, record)),
            _ => drop(self.records.remove(&id)),
        };
        for (id, line) in edited { put(id, &line, false); }
        for (id, line) in created { put(id, &line, true); }
    }

    /// Whether this export downgrades IFC4/IFC4X3 to IFC2X3 (callers skip `with_effective`'s inputs otherwise).
    pub(crate) fn armed(&self) -> bool { self.from.is_some() }

    /// `line`, record `id` converted to IFC2X3, naming the material its `Material`
    /// resolves to; empty when it names none, which the writer leaves out,
    /// adding its values to `dropped`.
    pub(crate) fn apply(&mut self, id: u32, line: String, dropped: &mut usize) -> String {
        let Some(from) = self.from else { return line };
        // The head names the type; most records stop before their slots are split.
        let Some(head) = crate::step_record_frame::record_head(&line) else { return line };
        if !head.type_name(&line).eq_ignore_ascii_case(WRITTEN_AS) { return line; }
        let Some((_, slots)) = crate::step_log::read_slots(&line) else { return line };
        let named = slots.first().and_then(|s| slot_ref(s));
        match (named, named.and_then(|r| resolve(&self.records, from, r))) {
            (Some(r), Some(m)) if m != r => crate::step_log::replace_argument(&line, 0, &format!("#{m}")).unwrap_or(line),
            (_, Some(_)) => line,
            _ => {
                *dropped += slots.iter().filter(|s| !slot_unset(s)).count();
                let named = named.and_then(|r| self.records.get(&r)).map_or("an unread record", |(t, _)| t.as_str());
                self.dropped.insert(id, named.to_owned());
                String::new()
            }
        }
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
