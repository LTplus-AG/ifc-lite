// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn supported_schema_keywords_keep_their_exact_type() {
    let exact = IfcType::from_str("IFCSLABSTANDARDCASE");
    assert_eq!(exact.as_str(), "IFCSLABSTANDARDCASE");
    assert!(exact.is_subtype_of(IfcType::IfcProduct));
}

#[test]
fn non_express_stratum_aliases_are_the_only_compatibility_geometry_override() {
    for &alias in crate::EXPORTER_STRATUM_ALIASES {
        assert!(crate::is_exporter_stratum_alias(alias));
        assert!(has_geometry_by_name(alias));
    }
    assert!(!crate::is_exporter_stratum_alias("IFCVENDORSTRATUM"));
}

#[test]
fn unknown_keywords_keep_their_owned_label_through_record_recovery() {
    let parsed = IfcType::from_str("IFC_VENDOR_WIDGET");
    assert_eq!(
        ifc_type_from_record(parsed, b"#1=IFC_VENDOR_WIDGET();").as_str(),
        "IFC_VENDOR_WIDGET"
    );
}

#[test]
fn classification_is_case_insensitive_across_the_generated_catalog() {
    for name in crate::generated::IFC_TYPES.iter().map(IfcType::as_str) {
        let expected = geometry_flags_by_name(name);
        assert_eq!(
            geometry_flags_by_name(&name.to_ascii_lowercase()),
            expected,
            "{name}"
        );
    }
}

#[test]
fn representative_geometry_categories_and_spatial_exclusions_stay_distinct() {
    for name in [
        "IFCWALL",
        "IFCBEAM",
        "IFCCHILLER",
        "IFCPAVEMENT",
        "IFCREINFORCEDSOIL",
    ] {
        assert!(has_geometry_by_name(name), "{name}");
    }
    for name in [
        "IFCPROJECT",
        "IFCMATERIAL",
        "IFCBUILDINGSTOREY",
        "IFCFACILITY",
        "IFCROAD",
    ] {
        assert!(!has_geometry_by_name(name), "{name}");
    }
}

#[test]
fn simple_geometry_categories_remain_explicit() {
    for name in ["IFCWALL", "IFCSLAB", "IFCBEAM", "IFCCOLUMN"] {
        assert!(is_simple_geometry_type(name), "{name}");
    }
    for name in ["IFCDOOR", "IFCWINDOW", "IFCFLOWSEGMENT", "IFCSPACE"] {
        assert!(!is_simple_geometry_type(name), "{name}");
    }
}

#[test]
fn unknown_keywords_use_fallbacks_without_growing_the_catalog_cache() {
    let before = classifications().len();
    assert!(has_geometry_by_name("IFCREINFORCINGVENDOREXTENSION"));
    assert!(!has_geometry_by_name("IFCVENDORGEOMETRY"));
    assert_eq!(classifications().len(), before);
}

/// Regression test for #5180: retiring the legacy IFC type table
/// (`rust/core/src/legacy_entities.rs`, removed by #5073) re-resolved every
/// legacy STEP keyword through the generated per-schema registry instead of
/// the old hand-maintained `LegacyEntityInfo` table. For 24 of the 26 names
/// in the old table's `LEGACY_ENTITY_NAMES` the two resolutions happen to
/// agree on `has_geometry_by_name`, `is_representationless_spatial_container_by_name`
/// and `is_simple_geometry_type`. For `IFCPROXY` and `IFCEQUIPMENTELEMENT`
/// they do not: the old table routed both through a *different* type
/// (`IfcBuildingElementProxy`, `IfcDistributionElement`) that
/// `schema_helpers::compute_is_simple`'s old secondary-type arms matched, so
/// `is_simple_geometry_type` was `false` (deferred geometry batch). The new
/// registry resolves each keyword to its *own* variant (`IfcProxy` parented
/// on `IfcProduct`, `IfcEquipmentElement` parented on `IfcElement`), neither
/// of which those arms match, so `is_simple_geometry_type` is now `true`
/// (eager first-frame batch, `rust/wasm-bindings/src/api/styling/prepass.rs`).
///
/// Expected values below are pinned as literal constants derived by hand
/// from the old table at commit `055f94f62` (`git show
/// 055f94f62:rust/core/src/legacy_entities.rs`), NOT by calling any
/// implementation (old or new) to produce the "expected" side — the deleted
/// sweep this replaces (`combined_geometry_flags_match_canonical_predicates_3987`)
/// was useless precisely because it compared the lookup cache to the same
/// build's uncached predicates instead of to an intended value, so it could
/// not have caught this flip even before the retirement.
#[test]
fn legacy_keyword_geometry_predicates_match_pre_retirement_intent_5180() {
    // (keyword, expected has_geometry, expected is_representationless_spatial_container,
    //  expected is_simple_geometry_type)
    //
    // `is_representationless_spatial_container_by_name` is `false` for every
    // legacy name both before and after the retirement: the old
    // `compute_is_representationless_spatial_container` special-cased
    // `get_legacy_entity_info(..).is_some()` to `false` unconditionally, and
    // the new registry resolves every one of these keywords to a concrete
    // `IfcProduct`-derived (non-spatial-container) variant.
    const UNAMBIGUOUS: &[(&str, bool, bool, bool)] = &[
        ("IFCPRESENTATIONSTYLEASSIGNMENT", false, false, true),
        ("IFCBEAMSTANDARDCASE", true, false, true),
        ("IFCCOLUMNSTANDARDCASE", true, false, true),
        ("IFCMEMBERSTANDARDCASE", true, false, true),
        ("IFCPLATESTANDARDCASE", true, false, true),
        ("IFCSLABSTANDARDCASE", true, false, true),
        ("IFCDOORSTANDARDCASE", true, false, false),
        ("IFCWINDOWSTANDARDCASE", true, false, false),
        ("IFCOPENINGSTANDARDCASE", true, false, false),
        ("IFCSLABELEMENTEDCASE", true, false, true),
        ("IFCWALLELEMENTEDCASE", true, false, true),
        ("IFCDOORSTYLE", false, false, true),
        ("IFCWINDOWSTYLE", false, false, true),
        ("IFCBUILDINGELEMENT", true, false, true),
        ("IFCBUILDINGELEMENTTYPE", false, false, true),
        ("IFCELECTRICDISTRIBUTIONPOINT", true, false, false),
        ("IFCELECTRICALELEMENT", true, false, true),
        ("IFCCHAMFEREDGEFEATURE", true, false, true),
        ("IFCROUNDEDEDGEFEATURE", true, false, true),
        ("IFCSTRUCTURALLINEARACTIONVARYING", true, false, true),
        ("IFCSTRUCTURALPLANARACTIONVARYING", true, false, true),
        ("IFCSOLIDSTRATUM", true, false, true),
        ("IFCVOIDSTRATUM", true, false, true),
        ("IFCWATERSTRATUM", true, false, true),
    ];

    for &(keyword, expected_has_geometry, expected_representationless, expected_simple) in
        UNAMBIGUOUS
    {
        assert_eq!(
            has_geometry_by_name(keyword),
            expected_has_geometry,
            "{keyword}: has_geometry_by_name"
        );
        assert_eq!(
            is_representationless_spatial_container_by_name(keyword),
            expected_representationless,
            "{keyword}: is_representationless_spatial_container_by_name"
        );
        assert_eq!(
            is_simple_geometry_type(keyword),
            expected_simple,
            "{keyword}: is_simple_geometry_type"
        );
    }

    // IFCPROXY and IFCEQUIPMENTELEMENT (#5180): has_geometry and
    // is_representationless_spatial_container are uncontested — both were
    // and remain geometry-bearing, non-spatial-container entities.
    for keyword in ["IFCPROXY", "IFCEQUIPMENTELEMENT"] {
        assert!(
            has_geometry_by_name(keyword),
            "{keyword}: has_geometry_by_name"
        );
        assert!(
            !is_representationless_spatial_container_by_name(keyword),
            "{keyword}: is_representationless_spatial_container_by_name"
        );
    }

    // `is_simple_geometry_type` for IFCPROXY and IFCEQUIPMENTELEMENT: the
    // retirement flipped both to `true` (eager first-frame batch) with no
    // decision behind it. The pre-retirement value `false` (deferred, like
    // IfcBuildingElementProxy and IfcDistributionElement) is the intended one.
    assert!(
        !is_simple_geometry_type("IFCPROXY"),
        "IFCPROXY: is_simple_geometry_type"
    );
    assert!(
        !is_simple_geometry_type("IFCEQUIPMENTELEMENT"),
        "IFCEQUIPMENTELEMENT: is_simple_geometry_type"
    );
}

/// #7914: `from_canonical_name` picks one candidate slot by a perfect hash;
/// the slot's own spelling, not the hash, decides a hit. Every generated registry must
/// resolve each of its keywords, in either case, to exactly itself. `ALL`
/// covers only the registry's own schema; the canonical registry also
/// resolves the names only a supplemental schema declares (IFCDOORSTYLE,
/// IFCALIGNMENT2DVERTICAL, ...), so the sweep takes `SUPPLEMENTAL` too and
/// proves it reached as many distinct types as there are dispatch arms.
#[test]
fn every_generated_registry_resolves_its_own_keywords() {
    struct Registry<T: 'static> {
        all: &'static [T],
        supplemental: &'static [T],
        arms: usize,
        name: fn(&T) -> &str,
        parse: fn(&str) -> T,
        declared: fn(&T) -> bool,
    }
    fn check<T: Eq + std::hash::Hash + std::fmt::Debug>(registry: Registry<T>) {
        let Registry {
            all,
            supplemental,
            arms,
            name,
            parse,
            declared,
        } = registry;
        assert!(all.iter().all(declared) && !supplemental.iter().any(declared));
        let universe: Vec<&T> = all.iter().chain(supplemental).collect();
        let distinct: std::collections::HashSet<&T> = universe.iter().copied().collect();
        assert_eq!((universe.len(), distinct.len()), (arms, arms));
        let names: std::collections::HashSet<&str> = universe.iter().map(|&t| name(t)).collect();
        for ifc_type in universe {
            let keyword = name(ifc_type);
            assert_eq!(&parse(keyword), ifc_type, "{keyword}");
            assert_eq!(&parse(&keyword.to_ascii_lowercase()), ifc_type, "{keyword}");
            // Near misses resolve only if they are themselves schema names.
            for near in [
                format!("{keyword}X"),
                keyword[..keyword.len() - 1].to_owned(),
            ] {
                if !names.contains(near.as_str()) {
                    assert!(!distinct.contains(&parse(&near)), "{near}");
                }
            }
        }
    }
    use crate::generated::{ifc2x3, ifc4, ifc4x1, ifc4x2};
    check(Registry {
        all: crate::generated::IFC_TYPES,
        supplemental: crate::generated::SUPPLEMENTAL_IFC_TYPES,
        arms: IfcType::CANONICAL_NAME_ARMS,
        name: IfcType::as_str,
        parse: IfcType::from_str,
        declared: IfcType::declared_by_canonical_schema,
    });
    macro_rules! check_schema {
        ($($schema:ident),*) => {$(
            check(Registry {
                all: $schema::ALL,
                supplemental: $schema::SUPPLEMENTAL,
                arms: $schema::IfcType::CANONICAL_NAME_ARMS,
                name: $schema::IfcType::as_str,
                parse: $schema::IfcType::from_str,
                declared: $schema::IfcType::declared_by_canonical_schema,
            });
        )*};
    }
    check_schema!(ifc2x3, ifc4, ifc4x1, ifc4x2);
}

/// The name table is minimal (every slot holds a schema name), so every
/// foreign keyword whose length is in range lands on some schema name's slot.
/// It must stay unknown and keep its own spelling, as must keywords outside
/// the hashed length range and non-ASCII ones.
#[test]
fn a_foreign_keyword_on_an_occupied_slot_is_not_that_type() {
    let longest = "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM";
    let too_long = format!("{longest}X");
    for foreign in [
        "IFCVENDORCKRFBAA",
        "IFCVENDORCHPRSBA",
        "IFCWAL",
        "IFCWALLS",
        "IFCWALLSTANDARDCASEX",
        "IFCCARTESIANTRANSFORMATIONOPERATOR4DNONUNIFORM",
        "IFC",
        "",
        too_long.as_str(),
    ] {
        let parsed = IfcType::from_str(foreign);
        assert!(
            matches!(parsed, IfcType::Unknown(_)),
            "{foreign:?} parsed as {parsed:?}"
        );
        assert_eq!(parsed.as_str(), foreign);
        assert!(matches!(
            IfcType::from_str(&foreign.to_ascii_lowercase()),
            IfcType::Unknown(_)
        ));
    }
    assert_eq!(
        IfcType::from_str(longest),
        IfcType::IfcCartesianTransformationOperator3DnonUniform
    );
    // Non-ASCII bytes hash like any others and are rejected by the compare.
    let accented = IfcType::from_str("IFCWÄLL");
    assert!(matches!(accented, IfcType::Unknown(_)), "{accented:?}");
    assert_eq!(accented.as_str(), "IFCWÄLL");
}
