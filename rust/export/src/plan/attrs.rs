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

impl ListEdit {
    /// `entries` with `remove` dropped, `substitute` applied in place, and
    /// `append` added at the end, as STEP list text.
    pub(crate) fn render(&self, entries: &[Option<u32>]) -> String {
        let kept: Vec<String> = entries
            .iter()
            .filter(|e| e.is_none_or(|id| !self.remove.contains(&id)))
            .map(|e| match e {
                Some(id) => format!("#{}", self.substitute.get(id).copied().unwrap_or(*id)),
                None => String::new(),
            })
            .chain(self.append.iter().map(|id| format!("#{id}")))
            .collect();
        format!("({})", kept.join(","))
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
        assert_eq!(edit.render(&[Some(1), Some(2), Some(3)]), "(#1,#3)");
        assert_eq!(edit.render(&[Some(2)]), "()");
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
        let entries = vec![Some(1), Some(2), Some(3)];
        let mut edit = ListEdit::default();
        edit.substitute.insert(2, 20);
        assert_eq!(edit.render(&entries), "(#1,#20,#3)");
    }

    #[test]
    fn list_edit_composes_strips_repoints_and_appends_on_one_list() {
        // A delete's strip, a leaf repoint and a folded member on the same
        // list all land in one rewrite.
        let entries = vec![Some(1), Some(2), Some(3)];
        let mut edit = ListEdit::default();
        edit.remove.insert(3);
        edit.substitute.insert(1, 10);
        edit.append.push(40);
        assert_eq!(edit.render(&entries), "(#10,#2,#40)");
    }
}
