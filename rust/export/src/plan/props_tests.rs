// SPDX-License-Identifier: MPL-2.0
use crate::plan::index::FileIndex;
use crate::step_ids::IdAllocator;
use super::{resolve_prop_write, PropOutcome};
use crate::plan::types::{PropScope, PropWrite, PsetKind};
use crate::plan::test_fixtures::{
    leaf_shared_by_occurrence_and_type, two_quantity_sets_on_one_wall_sharing_a_leaf, two_sets_on_one_wall_sharing_a_leaf,
    two_walls_separate_sets_sharing_a_leaf, two_walls_sharing_a_pset, two_walls_sharing_a_quantity_set, wall_with_own_pset, wall_with_type_owned_pset,
    wall_with_type_owned_quantity_set,
};

fn write(pset: &str, prop: &str, measure: &str, literal: &str, scope: PropScope, kind: PsetKind) -> PropWrite {
    PropWrite {
        pset: pset.into(),
        prop: prop.into(),
        measure_type: measure.into(),
        literal: literal.into(),
        unit: None,
        kind,
        scope,
    }
}

#[test]
fn edits_an_unshared_existing_value_in_place() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_own_pset(schema);
        let index = FileIndex::complete(&content);
        let mut ids = IdAllocator::after(index.max_id);
        let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'", PropScope::Occurrence, PsetKind::Property);

        let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).expect(schema);
        match outcome {
            PropOutcome::InPlace(edits) => {
                assert_eq!(edits.len(), 1, "{schema}");
                assert_eq!(edits[0].0, 30, "{schema}: the existing IfcPropertySingleValue, not a copy");
                assert!(edits[0].2.contains("IFCLABEL('2HR')"), "{schema}: {:?}", edits[0]);
            }
            PropOutcome::Append { .. } | PropOutcome::Fold { .. } => panic!("{schema}: an unshared value must edit in place, not append"),
            PropOutcome::CopyOnWrite { .. } => panic!("{schema}: an unshared value must edit in place, not clone"),
            PropOutcome::LeafCopyOnWrite { .. } => panic!("{schema}: an unshared value must edit in place, not clone a leaf"),
        }
    }
}

/// (1a/1b) A pset shared by two occurrences through one
/// `IfcRelDefinesByProperties`: patching one must clone the set (only the
/// diverging property becomes a new record), detach the patched occurrence
/// from the OLD relationship, and relate the clone with a NEW one — never
/// leave the patched object with a second same-named pset, and never touch
/// the sibling's own value.
#[test]
fn shared_occurrence_pset_is_cloned_not_duplicated() {
    let schema = "IFC4";
    let content = two_walls_sharing_a_pset(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'", PropScope::Occurrence, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::CopyOnWrite { new_records, detach } => {
            assert_eq!(new_records.len(), 3, "value copy + pset copy + rel");
            let value_text = &new_records[0].1;
            assert!(value_text.contains("IFCLABEL('2HR')"), "{value_text}");
            let pset_text = &new_records[1].1;
            assert!(pset_text.contains("'Pset_WallCommon'"), "{pset_text}");
            let rel_text = &new_records[2].1;
            assert!(rel_text.contains("(#10)"), "the new rel names only the patched wall: {rel_text}");
            assert!(!rel_text.contains("#11"), "the new rel does not also grab the other wall: {rel_text}");

            // The old rel (#32) is only NAMED for detach here: applying it
            // (and deciding whether #32 survives with #11 alone, or cascades
            // if #11 is not there either) is `delete::resolve_deletes`'s job.
            let (old_rel, _idx, detached_object) = detach;
            assert_eq!(old_rel, 32);
            assert_eq!(detached_object, 10);
        }
        other => panic!("a shared occurrence value must clone the set, got {other:?}"),
    }
    // (a) The old set (#30 inside #31) is untouched no matter what: a
    // reader following wall #11's own rel still sees the 1HR record.
    let raw = index.raw_line(30).unwrap();
    assert!(raw.contains("1HR"), "the shared property record must not itself change: {raw}");
}

/// (1d) Same shape, for a quantity set: `IfcElementQuantity` shared by two
/// occurrences clones the same way a property set does.
#[test]
fn shared_occurrence_quantity_set_is_cloned_not_duplicated() {
    let schema = "IFC4";
    let content = two_walls_sharing_a_quantity_set(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Qto_WallBaseQuantities", "Length", "IFCLENGTHMEASURE", "5.", PropScope::Occurrence, PsetKind::Quantity);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::CopyOnWrite { new_records, .. } => {
            assert_eq!(new_records.len(), 3, "value copy + quantity-set copy + rel");
            assert!(new_records[0].1.contains("IFCQUANTITYLENGTH"), "{}", new_records[0].1);
            // LengthValue is the defined type IfcLengthMeasure, not a SELECT:
            // STEP writes the bare number, never IFCLENGTHMEASURE(5.).
            assert!(new_records[0].1.contains(",5.,"), "{}", new_records[0].1);
            assert!(!new_records[0].1.contains("IFCLENGTHMEASURE"), "{}", new_records[0].1);
            assert!(new_records[1].1.contains("IFCELEMENTQUANTITY"), "{}", new_records[1].1);
        }
        other => panic!("a shared occurrence quantity value must clone the set, got {other:?}"),
    }
}

#[test]
fn occurrence_write_never_edits_a_type_owned_value() {
    let schema = "IFC4";
    let content = wall_with_type_owned_pset(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'3HR'", PropScope::Occurrence, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    assert!(matches!(outcome, PropOutcome::Append { .. }), "must append an override, never touch the type");
    let raw = index.raw_line(41).unwrap();
    assert!(raw.contains("2HR"), "the type's own property record must be untouched: {raw}");
}

#[test]
fn type_scope_edits_the_type_owned_value_directly() {
    let schema = "IFC4";
    let content = wall_with_type_owned_pset(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'3HR'", PropScope::Type, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::InPlace(edits) => {
            assert_eq!(edits[0].0, 41);
            assert!(edits[0].2.contains("3HR"));
        }
        PropOutcome::Append { .. } | PropOutcome::Fold { .. } => panic!("the type's own unshared pset should be edited in place"),
        PropOutcome::CopyOnWrite { .. } => panic!("the type's own unshared pset should be edited in place, not cloned"),
        PropOutcome::LeafCopyOnWrite { .. } => panic!("the type's own unshared value should be edited in place, not cloned"),
    }
}

/// Fail on purpose: an object with no related type at all must refuse a
/// type-scoped write rather than silently doing nothing.
#[test]
fn type_scope_refuses_when_the_object_has_no_type() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'3HR'", PropScope::Type, PsetKind::Property);

    let err = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap_err();
    assert!(err.contains("no related type"), "{err}");
}

// --- Leaf-level sharing: an exporter that deduplicates identical property
// or quantity VALUES can point two different sets at the exact same record,
// even though each set individually looks unshared (one relationship, one
// owner). Editing that leaf in place to satisfy one set's patch silently
// changes the value every other set naming it reports too.

/// Two sets on one wall sharing one leaf: patching the property found via
/// `Pset_A` must clone the leaf, not edit it — `Pset_B`'s own copy of the
/// same value would otherwise change along with it.
#[test]
fn a_leaf_shared_by_two_sets_on_one_wall_is_cloned_not_edited() {
    let schema = "IFC4";
    let content = two_sets_on_one_wall_sharing_a_leaf(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_A", "Reference", "IFCIDENTIFIER", "'R-2'", PropScope::Occurrence, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::LeafCopyOnWrite { new_records, replace } => {
            assert_eq!(new_records.len(), 1, "only the leaf is cloned, no new set or rel");
            assert!(new_records[0].1.contains("IFCIDENTIFIER('R-2')"), "{}", new_records[0].1);
            let (set_id, _idx, old_leaf, new_leaf) = replace;
            assert_eq!(set_id, 41, "Pset_A, the set actually being patched");
            assert_eq!(old_leaf, 30);
            assert_eq!(new_leaf, new_records[0].0);
        }
        other => panic!("a leaf shared by two sets must clone the leaf, got {other:?}"),
    }
    // Pset_B's own record of the shared leaf is untouched no matter what.
    let raw = index.raw_line(30).unwrap();
    assert!(raw.contains("R-1"), "the shared leaf record itself must not change: {raw}");
}

/// Same defect across two objects instead of one set: `Pset_A` (wall 10) and
/// `Pset_B` (wall 11) are each individually unshared — one relationship, one
/// owner apiece — but list the same leaf. Patching wall 10 must not touch
/// wall 11's value.
#[test]
fn a_leaf_shared_across_two_walls_separate_sets_is_cloned_not_edited() {
    let schema = "IFC4";
    let content = two_walls_separate_sets_sharing_a_leaf(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_A", "Reference", "IFCIDENTIFIER", "'R-2'", PropScope::Occurrence, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::LeafCopyOnWrite { replace, .. } => {
            let (set_id, _idx, old_leaf, _new_leaf) = replace;
            assert_eq!(set_id, 41);
            assert_eq!(old_leaf, 30);
        }
        other => panic!("a leaf shared across two walls must clone the leaf, got {other:?}"),
    }
    let raw = index.raw_line(30).unwrap();
    assert!(raw.contains("R-1"), "wall 11's own value must not change: {raw}");
}

/// A leaf shared between an occurrence set and a type set: patching the
/// occurrence override must clone the leaf rather than editing the value
/// the type set reports too.
#[test]
fn a_leaf_shared_by_an_occurrence_set_and_a_type_set_is_cloned_not_edited() {
    let schema = "IFC4";
    let content = leaf_shared_by_occurrence_and_type(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'", PropScope::Occurrence, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::LeafCopyOnWrite { replace, .. } => {
            let (set_id, _idx, old_leaf, _new_leaf) = replace;
            assert_eq!(set_id, 41, "the occurrence's own pset, not the type's");
            assert_eq!(old_leaf, 30);
        }
        other => panic!("a leaf shared with the type's set must clone the leaf, got {other:?}"),
    }
    let raw = index.raw_line(30).unwrap();
    assert!(raw.contains("1HR"), "the type's own value must not change: {raw}");
}

/// The quantity twin: an `IfcQuantityLength` leaf shared by two element
/// quantity sets on one wall must clone, not edit.
#[test]
fn a_quantity_leaf_shared_by_two_sets_is_cloned_not_edited() {
    let schema = "IFC4";
    let content = two_quantity_sets_on_one_wall_sharing_a_leaf(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Qto_A", "Length", "IFCLENGTHMEASURE", "5.", PropScope::Occurrence, PsetKind::Quantity);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::LeafCopyOnWrite { new_records, replace } => {
            assert!(new_records[0].1.contains("IFCQUANTITYLENGTH"), "{}", new_records[0].1);
            let (set_id, _idx, old_leaf, _new_leaf) = replace;
            assert_eq!(set_id, 41);
            assert_eq!(old_leaf, 30);
        }
        other => panic!("a shared quantity leaf must clone, got {other:?}"),
    }
    let raw = index.raw_line(30).unwrap();
    assert!(raw.contains("3."), "Qto_B's own quantity must not change: {raw}");
}

/// An unshared leaf — the ordinary case every other test in this module
/// already covers — must still edit in place, with no leaf clone and no
/// extra record, even now that leaf sharing is checked.
#[test]
fn an_unshared_leaf_is_still_edited_in_place_with_no_extra_records() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'", PropScope::Occurrence, PsetKind::Property);

    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    match outcome {
        PropOutcome::InPlace(edits) => {
            assert_eq!(edits.len(), 1);
            assert_eq!(edits[0].0, 30);
        }
        other => panic!("an unshared leaf must still edit in place, got {other:?}"),
    }
}

/// An unshared quantity edited in place gets the same bare literal the
/// synthesized path writes.
#[test]
fn unshared_quantity_value_is_edited_in_place_as_a_bare_literal() {
    let schema = "IFC4";
    let content = String::from_utf8(two_walls_sharing_a_quantity_set(schema)).unwrap().replace("(#10,#11)", "(#10)").into_bytes();
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Qto_WallBaseQuantities", "Length", "IFCLENGTHMEASURE", "5.", PropScope::Occurrence, PsetKind::Quantity);
    match resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap() {
        PropOutcome::InPlace(edits) => assert_eq!(edits, vec![(30, 3, "5.".to_string())]),
        other => panic!("an unshared quantity is edited in place, got {other:?}"),
    }
}

/// A type-owned quantity edited in place is written bare too.
#[test]
fn type_scope_quantity_value_is_edited_in_place_as_a_bare_literal() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_type_owned_quantity_set(schema);
        let index = FileIndex::complete(&content);
        let mut ids = IdAllocator::after(index.max_id);
        let w = write("Qto_WallBaseQuantities", "Length", "IFCLENGTHMEASURE", "5.", PropScope::Type, PsetKind::Quantity);
        match resolve_prop_write(&index, schema, 10, &w, &mut ids, None).expect(schema) {
            PropOutcome::InPlace(edits) => assert_eq!(edits, vec![(41, 3, "5.".to_string())], "{schema}"),
            other => panic!("{schema}: the type's own unshared quantity is edited in place, got {other:?}"),
        }
    }
}

/// A type-scoped in-place edit carries the caller's unit the same way an
/// occurrence-scoped one does, for a property and for a quantity.
#[test]
fn type_scope_in_place_edit_writes_the_unit() {
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = wall_with_type_owned_pset(schema);
        let index = FileIndex::complete(&content);
        let mut ids = IdAllocator::after(index.max_id);
        let mut w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'3HR'", PropScope::Type, PsetKind::Property);
        w.unit = Some("#77".into());
        match resolve_prop_write(&index, schema, 10, &w, &mut ids, None).expect(schema) {
            PropOutcome::InPlace(edits) => {
                assert_eq!(edits, vec![(41, 2, "IFCLABEL('3HR')".to_string()), (41, 3, "#77".to_string())], "{schema}")
            }
            other => panic!("{schema}: expected an in-place edit, got {other:?}"),
        }

        let content = wall_with_type_owned_quantity_set(schema);
        let index = FileIndex::complete(&content);
        let mut ids = IdAllocator::after(index.max_id);
        let mut w = write("Qto_WallBaseQuantities", "Length", "IFCLENGTHMEASURE", "5.", PropScope::Type, PsetKind::Quantity);
        w.unit = Some("#77".into());
        match resolve_prop_write(&index, schema, 10, &w, &mut ids, None).expect(schema) {
            PropOutcome::InPlace(edits) => {
                assert_eq!(edits, vec![(41, 3, "5.".to_string()), (41, 2, "#77".to_string())], "{schema}")
            }
            other => panic!("{schema}: expected an in-place edit, got {other:?}"),
        }
    }
}

/// Set and property names are compared decoded, as core reads them: a set
/// written `'Pset_O''Brien'` is the caller's `Pset_O'Brien`, so the write
/// edits it rather than adding a second set of the same name.
#[test]
fn a_set_named_with_an_escaped_quote_is_found_by_its_decoded_name() {
    let schema = "IFC4";
    let content = String::from_utf8(wall_with_own_pset(schema)).unwrap().replace("'Pset_WallCommon'", "'Pset_O''Brien'");
    let index = FileIndex::complete(content.as_bytes());
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_O'Brien", "FireRating", "IFCLABEL", "'2HR'", PropScope::Occurrence, PsetKind::Property);
    match resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap() {
        PropOutcome::InPlace(edits) => assert_eq!(edits[0].0, 30),
        other => panic!("the existing set must be edited, got {other:?}"),
    }
}

/// A caller's measure type, value and unit are written as given, so each is
/// held to the crate's caller-value rule: no comment, no second value, no
/// record terminator, and a measure type that is a name. Every refusal names
/// the write; none of them reaches the output.
#[test]
fn a_write_whose_step_text_is_not_one_value_is_refused() {
    let schema = "IFC4";
    let content = wall_with_own_pset(schema);
    let index = FileIndex::complete(&content);
    let cases: [(&str, &str, Option<&str>); 6] = [
        ("IFCLABEL", "'2HR' /* c */", None),
        ("IFCLABEL", "'a',#99", None),
        ("IFCLABEL", "'a'));#99=IFCWALL(", None),
        ("IFCLABEL(", "'a'", None),
        ("IFCLABEL", "'a'", Some("#5 /* c */")),
        ("IFCLABEL", "", None),
    ];
    for (measure, literal, unit) in cases {
        let mut w = write("Pset_WallCommon", "FireRating", measure, literal, PropScope::Occurrence, PsetKind::Property);
        w.unit = unit.map(str::to_string);
        let mut ids = IdAllocator::after(index.max_id);
        let refused = resolve_prop_write(&index, schema, 10, &w, &mut ids, None);
        assert!(refused.is_err(), "{measure} {literal:?} {unit:?} must be refused, got {refused:?}");
    }
    let mut w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'2HR'", PropScope::Occurrence, PsetKind::Property);
    w.unit = Some("$".into());
    assert!(resolve_prop_write(&index, schema, 10, &w, &mut IdAllocator::after(index.max_id), None).is_ok());
}

/// A set the wall's type lists in `HasPropertySets` and the wall also names
/// through its own relationship belongs to the type as well: an occurrence
/// write must clone it, never edit the type's value in place.
#[test]
fn occurrence_write_to_a_set_the_type_also_holds_is_copied() {
    use crate::plan::test_fixtures::pset_on_type_and_occurrence;
    for schema in ["IFC2X3", "IFC4", "IFC4X3"] {
        let content = pset_on_type_and_occurrence(schema);
        let index = FileIndex::complete(&content);
        let mut ids = IdAllocator::after(index.max_id);
        let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'4HR'", PropScope::Occurrence, PsetKind::Property);
        let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).expect(schema);
        assert!(matches!(outcome, PropOutcome::CopyOnWrite { .. }), "{schema}: {outcome:?}");
    }
}

#[test]
fn an_in_place_quantity_write_must_match_the_existing_quantity_kind() {
    let schema = "IFC4";
    let content = wall_with_type_owned_quantity_set(schema);
    let index = FileIndex::complete(&content);
    let area = write("Qto_WallBaseQuantities", "Length", "IFCAREAMEASURE", "3.5", PropScope::Type, PsetKind::Quantity);
    let err = super::in_place_edits(&index, schema, 41, &area).unwrap_err();
    assert!(err.contains("IFCQUANTITYAREA"), "{err}");
    let length = write("Qto_WallBaseQuantities", "Length", "IFCLENGTHMEASURE", "3.5", PropScope::Type, PsetKind::Quantity);
    assert!(super::in_place_edits(&index, schema, 41, &length).is_ok());
}

/// The other direction: a type-scoped write to a set an occurrence
/// relationship also relates would reach those objects, so it is refused.
#[test]
fn type_write_to_a_set_an_occurrence_relationship_also_holds_is_refused() {
    use crate::plan::test_fixtures::pset_on_type_and_occurrence;
    let schema = "IFC4";
    let content = pset_on_type_and_occurrence(schema);
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'4HR'", PropScope::Type, PsetKind::Property);
    assert!(resolve_prop_write(&index, schema, 10, &w, &mut ids, None).is_err());
}

/// A relationship that relates the set only to the type itself (IFC4 lets
/// `RelatedObjects` name a type) reaches nothing else, so the type write
/// still edits in place.
#[test]
fn type_write_to_a_set_related_only_to_the_type_itself_edits_in_place() {
    use crate::plan::test_fixtures::pset_on_type_also_related_to;
    let schema = "IFC4";
    let content = pset_on_type_also_related_to(schema, "(#40)");
    let index = FileIndex::complete(&content);
    let mut ids = IdAllocator::after(index.max_id);
    let w = write("Pset_WallCommon", "FireRating", "IFCLABEL", "'4HR'", PropScope::Type, PsetKind::Property);
    let outcome = resolve_prop_write(&index, schema, 10, &w, &mut ids, None).unwrap();
    assert!(matches!(outcome, PropOutcome::InPlace(_)), "{outcome:?}");
}
