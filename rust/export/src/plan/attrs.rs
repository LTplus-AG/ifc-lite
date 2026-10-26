// SPDX-License-Identifier: MPL-2.0
//! Schema-resolved attribute name -> index, and the small text helpers built
//! on it. `ifc_lite_core::attribute_names_for_schema` already carries the
//! per-schema (IFC2X3/IFC4/IFC4X1/IFC4X2/IFC4X3) EXPRESS attribute order —
//! this module only turns "the position of `Name`" into an index a caller
//! never has to spell out, and never hardcodes for one schema (`Name` sits at
//! index 2 on every `IfcRoot` subtype in every bundled schema, but
//! `IfcPropertySingleValue.Description` was renamed `Specification` in
//! IFC4X3 without moving, and `IfcGridPlacement` gained a leading
//! `PlacementRelTo` in IFC4X3 that shifts every slot after it — a caller
//! resolving by name never notices either).

use std::collections::{BTreeMap, HashMap, HashSet};

use super::index::FileIndex;

/// Whether `class` is a spatial element in `file_schema`
/// (`IfcSpatialStructureElement` in IFC2X3, its `IfcSpatialElement`
/// supertype later).
pub(crate) fn is_spatial(file_schema: &str, class: &str) -> bool {
    ["IFCSPATIALSTRUCTUREELEMENT", "IFCSPATIALELEMENT"].iter().any(|p| ifc_lite_core::is_subtype_of_for_schema(file_schema, class, p))
}

/// A place in the project spatial tree: the project itself or a spatial
/// structure element (site, building, storey, space, facility and parts).
/// Spatial zones and external spatial elements are spatial but not part of
/// that tree.
pub(crate) fn in_structure(file_schema: &str, class: &str) -> bool {
    class == "IFCPROJECT" || ifc_lite_core::is_subtype_of_for_schema(file_schema, class, "IFCSPATIALSTRUCTUREELEMENT")
}

/// The index of `attr_name` on `entity_type` in `file_schema`, or `None` when
/// the schema does not declare that entity or that attribute.
pub(crate) fn attribute_index(file_schema: &str, entity_type: &str, attr_name: &str) -> Option<usize> {
    ifc_lite_core::attribute_names_for_schema(file_schema, entity_type)?
        .iter()
        .position(|n| *n == attr_name)
}

/// Every change one plan makes to one list-valued attribute of one record:
/// entries a delete or a copy-on-write detach strips, entries a leaf
/// copy-on-write repoints, and new members a write folds in. Collected from
/// every source first and rendered once against the source list, so no
/// source's change discards another's.
#[derive(Debug, Default)]
pub(crate) struct ListEdit {
    pub(crate) remove: std::collections::HashSet<u32>,
    pub(crate) substitute: std::collections::HashMap<u32, u32>,
    pub(crate) append: Vec<u32>,
}

/// One entry of a source list: a reference, or any other value (a typed
/// value, a nested list), kept as written.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ListEntry<'s> {
    Ref(u32),
    Other(&'s str),
}

impl<'s> ListEntry<'s> {
    /// Every entry of the list value `slot`; `None` when it is not a list.
    pub(crate) fn parse_list(slot: &'s str) -> Option<Vec<Self>> {
        let items = ifc_lite_core::StepListItems::of_list(slot.as_bytes())?;
        Some(
            items
                .map(|item| match ifc_lite_core::parser::parse_ref(item) {
                    Some(id) => ListEntry::Ref(id),
                    // The items are sub-slices of `slot`, so this never splits a character.
                    None => ListEntry::Other(std::str::from_utf8(item).unwrap_or_default()),
                })
                .collect(),
        )
    }
}

impl ListEdit {
    /// `entries` with `remove` dropped, `substitute` applied in place, and
    /// `append` added at the end, as STEP list text. A non-reference entry
    /// is written back as it was.
    pub(crate) fn render(&self, entries: &[ListEntry<'_>]) -> String {
        let mut kept: Vec<String> = Vec::with_capacity(entries.len() + self.append.len());
        for entry in entries {
            match *entry {
                ListEntry::Ref(id) if self.remove.contains(&id) => {}
                ListEntry::Ref(id) => kept.push(format!("#{}", self.substitute.get(&id).copied().unwrap_or(id))),
                ListEntry::Other(text) => kept.push(text.to_string()),
            }
        }
        kept.extend(self.append.iter().map(|id| format!("#{id}")));
        format!("({})", kept.join(","))
    }
}

/// Every list change on one (record, attribute) slot, rendered once against
/// the source list, so no change discards another's.
pub(crate) fn render_list_edits(
    index: &FileIndex,
    list_edits: HashMap<(u32, usize), ListEdit>,
    removed: &HashSet<u32>,
    edits_by_id: &mut HashMap<u32, BTreeMap<usize, String>>,
) {
    for ((id, idx), edit) in list_edits {
        if removed.contains(&id) {
            continue;
        }
        let Some(slot) = index.raw_line(id).and_then(|line| crate::step_text::attribute_of(&line, idx)) else { continue };
        let entries = match ListEntry::parse_list(&slot) {
            Some(entries) => entries,
            // An unset list (`$`, e.g. a project with no contexts yet) takes
            // appends as a new list. Any other slot is left as written.
            None if slot.trim() == "$" && edit.remove.is_empty() && edit.substitute.is_empty() => Vec::new(),
            None => continue,
        };
        edits_by_id.entry(id).or_default().insert(idx, edit.render(&entries));
    }
}

/// Build one record `#id=TYPE(...);` from the schema's own attribute order:
/// every slot named in `fields` gets that value, everything else is `$`.
/// Positions are never counted by hand, so the same call is right for a
/// type that gained or lost attributes between schemas.
///
/// In IFC2X3 a slot the schema declares mandatory and that has a value
/// which claims nothing (`.NOTDEFINED.` for an enum, `.F.` for a BOOLEAN)
/// takes that value rather than `$`, from the same generated table the
/// schema downgrade uses: IFC2X3 made mandatory several enums IFC4 relaxed
/// (`IfcWallType.PredefinedType`), and a
/// record appended here should not be less valid than one converted there.
pub(crate) fn build_record(file_schema: &str, id: u32, entity_type: &str, fields: &[(&str, String)]) -> String {
    let names = ifc_lite_core::attribute_names_for_schema(file_schema, entity_type).unwrap_or(&[]);
    let mut slots = vec!["$".to_string(); names.len()];
    for (i, n) in names.iter().enumerate() {
        if let Some((_, v)) = fields.iter().find(|(name, _)| name == n) {
            slots[i] = v.clone();
        }
    }
    if file_schema.to_ascii_uppercase().starts_with("IFC2X3") {
        if let Some((arity, required)) = crate::schema_ifc2x3_slots::required_slots(entity_type) {
            if usize::from(arity) == slots.len() {
                for &(index, _, fill) in required {
                    let slot = &mut slots[usize::from(index)];
                    if slot == "$" && !fill.is_empty() {
                        *slot = fill.to_string();
                    }
                }
            }
        }
    }
    format!("#{id}={entity_type}({});", slots.join(","))
}

/// The mandatory attributes a built record leaves `$`, by name, from the
/// generated required-slot tables: IFC2X3's for an IFC2X3 file, IFC4's for
/// IFC4 and IFC4X3 when the record has IFC4's attribute count for its type
/// (the later schemas keep IFC4's mandatory slots where the layout is the
/// same). Empty when the record does not parse or no table covers it.
pub(crate) fn unset_required(file_schema: &str, record: &str) -> Vec<&'static str> {
    let Some(frame) = crate::step_record_frame::record_frame(record) else { return Vec::new() };
    let entity_type = frame.head.type_name(record).to_ascii_uppercase();
    let Some(args) = crate::step_slot::slots_of(frame.args(record)) else {
        return Vec::new();
    };
    let unset = |index: u8| args.get(usize::from(index)).is_some_and(|a| a.trim() == "$");
    if file_schema.to_ascii_uppercase().starts_with("IFC2X3") {
        return match crate::schema_ifc2x3_slots::required_slots(&entity_type) {
            Some((arity, slots)) if usize::from(arity) == args.len() => {
                slots.iter().filter(|&&(index, _, _)| unset(index)).map(|&(_, name, _)| name).collect()
            }
            _ => Vec::new(),
        };
    }
    use crate::generated::ifc4_required_slots::IFC4_REQUIRED_SLOTS;
    match IFC4_REQUIRED_SLOTS.binary_search_by(|row| row.0.cmp(entity_type.as_str())) {
        Ok(i) if usize::from(IFC4_REQUIRED_SLOTS[i].1) == args.len() => {
            IFC4_REQUIRED_SLOTS[i].2.iter().filter(|&&(index, _)| unset(index)).map(|&(_, name)| name).collect()
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_always_index_2_on_a_root_subtype_in_every_bundled_schema() {
        for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
            assert_eq!(attribute_index(schema, "IFCWALL", "Name"), Some(2), "{schema}");
        }
    }

    #[test]
    fn property_single_value_description_moved_name_not_index_in_ifc4x3() {
        // IFC4X3 renamed slot 1 `Description` -> `Specification`; the OLD
        // name must not resolve there any more.
        assert_eq!(attribute_index("IFC4X3", "IFCPROPERTYSINGLEVALUE", "Specification"), Some(1));
        assert_eq!(attribute_index("IFC4X3", "IFCPROPERTYSINGLEVALUE", "Description"), None);
        assert_eq!(attribute_index("IFC4", "IFCPROPERTYSINGLEVALUE", "Description"), Some(1));
    }

    #[test]
    fn grid_placement_gains_a_leading_slot_in_ifc4x3_so_every_index_shifts() {
        assert_eq!(attribute_index("IFC2X3", "IFCGRIDPLACEMENT", "PlacementLocation"), Some(0));
        assert_eq!(attribute_index("IFC4X3", "IFCGRIDPLACEMENT", "PlacementLocation"), Some(1));
    }

    #[test]
    fn unknown_attribute_and_unknown_schema_both_resolve_to_none() {
        assert_eq!(attribute_index("IFC4", "IFCWALL", "NoSuchAttribute"), None);
        assert_eq!(attribute_index("NOT-A-SCHEMA", "IFCWALL", "Name"), None);
    }

    #[test]
    fn list_edit_drops_only_the_removed_entries_and_can_go_empty() {
        let mut edit = ListEdit::default();
        edit.remove.insert(2);
        let refs = |ids: &[u32]| ids.iter().map(|&id| ListEntry::Ref(id)).collect::<Vec<_>>();
        assert_eq!(edit.render(&refs(&[1, 2, 3])), "(#1,#3)");
        assert_eq!(edit.render(&refs(&[2])), "()");
        let mixed = ListEntry::parse_list("(#1, IFCPARAMETERVALUE(0.), /* c */ #2)").unwrap();
        assert_eq!(edit.render(&mixed), "(#1,IFCPARAMETERVALUE(0.))", "a non-reference entry is kept as written");
    }

    #[test]
    fn build_record_follows_each_schema_order_and_fills_ifc2x3_mandatory_enums() {
        let fields = [("GlobalId", "'g'".to_string()), ("Name", "'T'".to_string())];
        // IFC2X3 declares PredefinedType mandatory on IfcWallType; IFC4 does not.
        assert_eq!(build_record("IFC2X3", 5, "IFCWALLTYPE", &fields), "#5=IFCWALLTYPE('g',$,'T',$,$,$,$,$,$,.NOTDEFINED.);");
        assert_eq!(build_record("IFC4", 5, "IFCWALLTYPE", &fields), "#5=IFCWALLTYPE('g',$,'T',$,$,$,$,$,$,$);");
        assert_eq!(build_record("IFC4", 6, "IFCWALL", &fields).matches(',').count(), 8);
        assert_eq!(build_record("IFC2X3", 6, "IFCWALL", &fields).matches(',').count(), 7);
    }

    #[test]
fn list_edit_swaps_every_named_entry_in_place() {
        let entries = [ListEntry::Ref(1), ListEntry::Ref(2), ListEntry::Ref(3)];
        let mut edit = ListEdit::default();
        edit.substitute.insert(2, 20);
        assert_eq!(edit.render(&entries), "(#1,#20,#3)");
    }

    #[test]
    fn list_edit_composes_strips_repoints_and_appends_on_one_list() {
        // A delete's strip, a leaf repoint and a folded member on the same
        // list all land in one rewrite.
        let entries = [ListEntry::Ref(1), ListEntry::Ref(2), ListEntry::Ref(3)];
        let mut edit = ListEdit::default();
        edit.remove.insert(3);
        edit.substitute.insert(1, 10);
        edit.append.push(40);
        assert_eq!(edit.render(&entries), "(#10,#2,#40)");
    }
}
