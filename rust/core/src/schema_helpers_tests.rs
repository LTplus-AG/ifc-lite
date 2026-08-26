// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super::schema_helpers`]. Split out of `schema_helpers.rs` to
//! keep that module under the 400-line rule (AGENTS.md), matching the
//! `stream_meta.rs` / `stream_meta_tests.rs` pattern.

use super::*;

#[test]
fn building_elements_have_geometry() {
    for name in [
        "IFCWALL",
        "IFCSLAB",
        "IFCBEAM",
        "IFCCOLUMN",
        "IFCDOOR",
        "IFCWINDOW",
        "IFCROOF",
        "IFCSTAIR",
        "IFCSHADINGDEVICE",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

#[test]
fn mep_elements_have_geometry() {
    for name in [
        "IFCFLOWSEGMENT",
        "IFCFLOWFITTING",
        "IFCENERGYCONVERSIONDEVICE",
        "IFCFLOWTREATMENTDEVICE",
        "IFCBOILER",
        "IFCPUMP",
        "IFCVALVE",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

/// Regression for PR #585 — IfcSolarDevice was missing because the
/// whitelist matched leaf names directly even though its parent
/// `IfcEnergyConversionDevice` was already in the list.
#[test]
fn solar_device_has_geometry() {
    assert!(has_geometry_by_name("IFCSOLARDEVICE"));
    assert!(has_geometry_by_name("IfcSolarDevice"));
}

#[test]
fn ifc4x3_infrastructure_have_geometry() {
    for name in [
        "IFCBEARING",
        "IFCKERB",
        "IFCPAVEMENT",
        "IFCRAIL",
        "IFCTRACKELEMENT",
        "IFCSIGN",
        "IFCSIGNAL",
        "IFCEARTHWORKSCUT",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

#[test]
fn reinforcement_variants_have_geometry() {
    assert!(has_geometry_by_name("IFCREINFORCINGBAR"));
    assert!(has_geometry_by_name("IFCREINFORCINGMESH"));
    assert!(has_geometry_by_name("IFCREINFORCEDSOIL"));
}

#[test]
fn standardcase_and_elementedcase_have_geometry() {
    for name in [
        "IFCBEAMSTANDARDCASE",
        "IFCSLABSTANDARDCASE",
        "IFCSLABELEMENTEDCASE",
        "IFCWALLSTANDARDCASE",
        "IFCWALLELEMENTEDCASE",
        "IFCDOORSTANDARDCASE",
        "IFCWINDOWSTANDARDCASE",
        "IFCOPENINGSTANDARDCASE",
    ] {
        assert!(has_geometry_by_name(name), "{name} should have geometry");
    }
}

#[test]
fn space_and_site_have_geometry() {
    assert!(has_geometry_by_name("IFCSPACE"));
    assert!(has_geometry_by_name("IFCSITE"));
    assert!(has_geometry_by_name("IFCOPENINGELEMENT"));
    // #1075: IfcSpatialZone may carry a body (Revit Family/Dynamo GFA
    // volumes) — it is meshed like IfcSpace when a representation exists.
    assert!(has_geometry_by_name("IFCSPATIALZONE"));
}

/// #1910: terrain/DGM exporters attach an IfcShellBasedSurfaceModel
/// directly to IfcBuilding. Blocking the class meant the entity never
/// became a geometry job, so the model rendered nothing at all.
#[test]
fn building_bears_geometry() {
    assert!(has_geometry_by_name("IFCBUILDING"));
    assert!(has_geometry_by_name("IfcBuilding"));
    // Its siblings under IfcSpatialStructureElement stay blocked — no
    // exporter has been observed giving them a body.
    assert!(!has_geometry_by_name("IFCBUILDINGSTOREY"));
    assert!(!has_geometry_by_name("IFCFACILITY"));
}

#[test]
fn legacy_ifc2x3_distribution_names_have_geometry() {
    // Routed through legacy_entities now (was an inline match arm).
    assert!(has_geometry_by_name("IFCEQUIPMENTELEMENT"));
    assert!(has_geometry_by_name("IFCELECTRICDISTRIBUTIONPOINT"));
    // The name this line carried until #3172 was `IFCELECTRICALDISTRIBUTIONPOINT`,
    // which is not an IFC2X3 entity — the real one has no "AL". The assertion
    // was green because the table it read carried the same misspelling, so the
    // pair certified each other and neither described a file. Pinned as a
    // negative so a respelling cannot quietly come back.
    assert!(!has_geometry_by_name("IFCELECTRICALDISTRIBUTIONPOINT"));
}

#[test]
fn non_geometric_spatial_excluded() {
    for name in [
        // The original whitelist excluded these explicitly.
        // IFCBUILDING moved out — see `building_bears_geometry` (#1910).
        "IFCBUILDINGSTOREY",
        "IFCFACILITY",
        "IFCFACILITYPART",
        // Abstract bases — same logic, never rendered directly.
        "IFCSPATIALELEMENT",
        "IFCSPATIALSTRUCTUREELEMENT",
        // IFC4X3 facility subtypes: previously absent from the whitelist
        // and would now leak through if the block-list were leaf-only
        // (regression flagged on the original PR review).
        "IFCBRIDGE",
        "IFCROAD",
        "IFCRAILWAY",
        "IFCMARINEFACILITY",
        "IFCBRIDGEPART",
        "IFCFACILITYPARTCOMMON",
        // External spatial elements are abstract air volumes, not
        // rendered. Not in the original whitelist.
        "IFCEXTERNALSPATIALELEMENT",
        "IFCEXTERNALSPATIALSTRUCTUREELEMENT",
    ] {
        assert!(!has_geometry_by_name(name), "{name} should NOT have geometry");
    }
}

#[test]
fn non_products_excluded() {
    for name in [
        "IFCPROJECT",
        "IFCMATERIAL",
        "IFCPROPERTYSET",
        "IFCRELAGGREGATES",
        "IFCDIMENSIONALEXPONENTS",
        "IFCSURFACESTYLERENDERING",
        "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
        "IFCCARTESIANPOINT",
    ] {
        assert!(!has_geometry_by_name(name), "{name} should NOT have geometry");
    }
}

#[test]
fn legacy_proxy_and_buildingelement_have_geometry() {
    // From legacy_entities: both map to renderable types
    assert!(has_geometry_by_name("IFCPROXY"));
    assert!(has_geometry_by_name("IFCBUILDINGELEMENT"));
}

#[test]
fn unknown_garbage_excluded() {
    // Reinforcement substring tightened to a prefix — unrelated tokens
    // containing "REINFORC" are no longer accepted.
    assert!(!has_geometry_by_name("IFCNOTAREALTYPE"));
    assert!(!has_geometry_by_name(""));
    assert!(!has_geometry_by_name("FOOREINFORCEDBAR"));
}

#[test]
fn cached_results_are_consistent() {
    // Hit the cache twice for the same name and confirm both return the
    // same value (regression for any race in the cache layer).
    for _ in 0..3 {
        assert!(has_geometry_by_name("IFCWALL"));
        assert!(!has_geometry_by_name("IFCPROJECT"));
        assert!(is_simple_geometry_type("IFCWALL"));
        assert!(!is_simple_geometry_type("IFCWINDOW"));
    }
}

#[test]
fn is_simple_geometry_type_routes_correctly() {
    // Structural / structural-adjacent: simple.
    assert!(is_simple_geometry_type("IFCWALL"));
    assert!(is_simple_geometry_type("IFCSLAB"));
    assert!(is_simple_geometry_type("IFCBEAM"));
    assert!(is_simple_geometry_type("IFCCOLUMN"));

    // Secondary categories.
    assert!(!is_simple_geometry_type("IFCWINDOW"));
    assert!(!is_simple_geometry_type("IFCDOOR"));
    assert!(!is_simple_geometry_type("IFCOPENINGELEMENT"));
    assert!(!is_simple_geometry_type("IFCFLOWSEGMENT"));
    assert!(!is_simple_geometry_type("IFCSOLARDEVICE"));
    assert!(!is_simple_geometry_type("IFCSPACE"));
    assert!(!is_simple_geometry_type("IFCANNOTATION"));
    assert!(!is_simple_geometry_type("IFCBUILDINGELEMENTPROXY"));

    // Mixed-case input — exercises the `to_ascii_uppercase` branch.
    assert!(is_simple_geometry_type("IfcWall"));
    assert!(!is_simple_geometry_type("IfcDoor"));
}

// #1910 review follow-up: `nth_attribute_is_present` had no direct unit
// test — every existing reference was production use or an integration
// test exercising it incidentally. These pin the documented contract:
// "attribute at `index` (0-based, top-level — respects nested parens and
// quoted strings) is present and non-null (`$`)".

#[test]
fn nth_attribute_present_and_non_null_is_true() {
    let entity = b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1',$,$,#18,#39,$,.ELEMENT.,0.);";
    // index 0: 'guid' — present, non-null.
    assert!(nth_attribute_is_present(entity, 0));
    // index 6: #39 (Representation) — present, non-null.
    assert!(nth_attribute_is_present(entity, 6));
}

#[test]
fn nth_attribute_dollar_is_false() {
    let entity = b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1',$,$,#18,$,$,.ELEMENT.,0.);";
    // index 6: $ (Representation) — present but null.
    assert!(!nth_attribute_is_present(entity, 6));
    // index 1: $ (OwnerHistory) — same.
    assert!(!nth_attribute_is_present(entity, 1));
}

#[test]
fn nth_attribute_past_the_end_is_false() {
    let entity = b"#1=IFCWALL('guid',$,'Wall');";
    // Only 3 top-level attributes (indices 0..=2); index 10 doesn't exist.
    assert!(!nth_attribute_is_present(entity, 10));
}

#[test]
fn nth_attribute_empty_value_is_false() {
    // `,,` — the middle attribute is an empty token, not `$` and not a
    // value. The scanner treats an empty trimmed token as absent: the
    // `!token.is_empty()` check in `nth_attribute_is_present` fails.
    let entity = b"#1=IFCFOO('a',,'c');";
    assert!(!nth_attribute_is_present(entity, 1));
    // Confirm the neighbours parsed correctly around the empty slot.
    assert!(nth_attribute_is_present(entity, 0));
    assert!(nth_attribute_is_present(entity, 2));
}

#[test]
fn nth_attribute_nested_parens_are_not_top_level_commas() {
    // IFCPOLYLOOP((#20,#21,#22)) — the whole nested list is attribute 0;
    // the commas inside the inner parens must not be counted as top-level
    // separators, and there must be no attribute 1.
    let entity = b"#30=IFCPOLYLOOP((#20,#21,#22),$);";
    assert!(nth_attribute_is_present(entity, 0));
    assert!(!nth_attribute_is_present(entity, 1));
    assert!(!nth_attribute_is_present(entity, 2));
}

#[test]
fn nth_attribute_quoted_comma_and_paren_are_not_top_level() {
    // A quoted string containing both a comma and parens must not be
    // split on, nor have its parens counted toward nesting depth.
    let entity =
        b"#40=IFCBUILDINGSTOREY('guid',$,'Level 1, west (annex)',$);";
    assert!(nth_attribute_is_present(entity, 0)); // 'guid'
    assert!(!nth_attribute_is_present(entity, 1)); // $
    assert!(nth_attribute_is_present(entity, 2)); // the quoted string itself
    assert!(!nth_attribute_is_present(entity, 3)); // $
    // Nothing beyond attribute 3 — the embedded comma/parens didn't
    // fabricate extra attributes.
    assert!(!nth_attribute_is_present(entity, 4));
}

#[test]
fn nth_attribute_escaped_quote_stays_inside_the_string() {
    // STEP escapes an embedded `'` as `''`. The scanner must not treat
    // the escape as the string's closing quote.
    let entity = b"#1=IFCWALL('guid',$,'quo''te',$);";
    assert!(nth_attribute_is_present(entity, 2)); // 'quo''te'
    assert!(!nth_attribute_is_present(entity, 3)); // $
    // No phantom attribute 4 from mis-parsing the escape as a delimiter.
    assert!(!nth_attribute_is_present(entity, 4));
}

#[test]
fn nth_attribute_no_open_paren_is_false() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL;", 0));
}

#[test]
fn nth_attribute_no_close_paren_is_false() {
    assert!(!nth_attribute_is_present(b"#1=IFCWALL('guid'", 0));
}

#[test]
fn nth_attribute_reversed_boundary_is_false() {
    // `)` appears before `(` — must not panic or index out of bounds.
    assert!(!nth_attribute_is_present(b")(", 0));
    assert!(!nth_attribute_is_present(b"garbage)stuff(more", 0));
}

/// Every key in `legacy_entities.rs`, derived rather than copied.
///
/// Two tests assert OPPOSITE directions about these names, and a hand-written
/// list would let each of them silently under-cover:
/// `every_legacy_arm_maps_onto_a_known_product` says each maps to a known base
/// type; `every_legacy_key_is_unknown_to_the_generated_enum` says none of them
/// is a name `IfcType::from_str` already knows.
///
/// This used to be a 26-entry copy of the arm keys, and a copy answers only
/// for the names someone remembered to add to it. A 27th arm reached neither
/// test -- measured, not assumed: an arm added with `has_geometry: true` and a
/// base type that is not an `IfcProduct`, the exact thing
/// `every_legacy_arm_maps_onto_a_known_product` exists to refuse, passed both
/// the Rust suite and `scripts/check-legacy-entity-coverage.mjs`.
///
/// `LEGACY_ENTITY_NAMES` is the list to borrow because it is already held to
/// the arms in BOTH directions by that lint, which reads the arm keys out of
/// `legacy_entities.rs` and fails on a name in either set and not the other.
/// So an arm that never reaches this loop cannot exist without that gate going
/// red first, and no new mechanism -- and no `include_str!` of a sibling
/// module, which AGENTS.md bans -- is needed here.
const LEGACY_KEYS: &[&str] = crate::legacy_entities::LEGACY_ENTITY_NAMES;

/// The borrowed list must not be empty, or both loops below iterate nothing
/// and report success over a table they never read. The floor is deliberately
/// far under the current count: this asks whether the const is populated, not
/// whether it has a particular size, and a floor that tracks the exact count
/// would have to be edited by the same hand that adds an arm.
#[test]
fn the_legacy_key_list_is_not_empty() {
    assert!(
        LEGACY_KEYS.len() >= 20,
        "LEGACY_KEYS came back with {} names; the two loops that read it would pass vacuously",
        LEGACY_KEYS.len()
    );
}

/// The six IFC2X3 products #3172 added to `legacy_entities.rs`.
///
/// Each one is CONCRETE and carries both `ObjectPlacement` and
/// `Representation` in `@ifc-lite/data`'s IFC2X3 table, and each one resolved
/// to `IfcType::Unknown` before the fix. `Unknown` is a subtype of nothing,
/// so an IFC2X3 file containing them lost them from the attribute export
/// (`rust/export/src/model.rs` keeps only `is_subtype_of(IfcProduct)`) AND
/// from meshing (`has_geometry_by_name` refuses `Unknown`) — the two passes
/// agreed, on dropping the entity from both.
///
/// The mapping targets are asserted, not just "is a product": a mapping that
/// resolved every one of them to `IfcBuildingElementProxy` would satisfy the
/// product check while throwing the semantics away.
#[test]
fn legacy_ifc2x3_products_resolve_to_their_own_supertype() {
    for (name, expected) in [
        ("IFCELECTRICALELEMENT", IfcType::IfcElement),
        ("IFCELECTRICDISTRIBUTIONPOINT", IfcType::IfcFlowController),
        ("IFCCHAMFEREDGEFEATURE", IfcType::IfcFeatureElementSubtraction),
        ("IFCROUNDEDEDGEFEATURE", IfcType::IfcFeatureElementSubtraction),
        (
            "IFCSTRUCTURALLINEARACTIONVARYING",
            IfcType::IfcStructuralLinearAction,
        ),
        (
            "IFCSTRUCTURALPLANARACTIONVARYING",
            IfcType::IfcStructuralPlanarAction,
        ),
    ] {
        let resolved = legacy_aware_ifc_type(name);
        assert_eq!(resolved, expected, "{name} resolved to {resolved:?}");
        assert!(
            resolved.is_subtype_of(IfcType::IfcProduct),
            "{name} must reach IfcProduct or the attribute exporter drops it"
        );
        assert!(
            has_geometry_by_name(name),
            "{name} must reach the geometry pass"
        );
    }
}

/// `IfcFlowController` replaced the misspelt arm's `IfcDistributionElement`,
/// and the comment in `legacy_entities.rs` claims that is a NARROWING rather
/// than a change of answer. Claimed is not measured, so it is measured here:
/// anything keying on the old target still sees the same verdict.
#[test]
fn the_electric_distribution_point_remap_only_narrows() {
    let t = legacy_aware_ifc_type("IFCELECTRICDISTRIBUTIONPOINT");
    assert_eq!(t, IfcType::IfcFlowController);
    assert!(
        t.is_subtype_of(IfcType::IfcDistributionElement),
        "the arm used to answer IfcDistributionElement; IfcFlowController must still be one"
    );
}

/// The two edge features are subtraction operands, and that has to survive the
/// mapping: `IfcFeatureElementSubtraction` keeps them OUT of the void/CSG path
/// (which matches `IfcType::IfcOpeningElement` exactly, not by inheritance)
/// while keeping them out of construction-projection profiles, which gate on
/// `is_subtype_of(IfcFeatureElement)` (#979). Mapping them to
/// `IfcOpeningElement` would have satisfied every assertion above and fed two
/// unrelated entities to the boolean cutter.
#[test]
fn edge_features_are_subtraction_operands_not_openings() {
    for name in ["IFCCHAMFEREDGEFEATURE", "IFCROUNDEDEDGEFEATURE"] {
        let t = legacy_aware_ifc_type(name);
        assert!(t.is_subtype_of(IfcType::IfcFeatureElement), "{name}");
        assert_ne!(t, IfcType::IfcOpeningElement, "{name}");
        assert!(!t.is_subtype_of(IfcType::IfcOpeningElement), "{name}");
    }
}

/// Every arm in `legacy_entities.rs` must map onto a type the generated
/// IFC4X3 enum actually has, and an arm flagged `has_geometry` must reach
/// `IfcProduct`. A mapping to `Unknown` would leave the entity exactly as
/// dropped as having no arm at all, while looking handled in the table.
#[test]
fn every_legacy_arm_maps_onto_a_known_product() {
    for &name in LEGACY_KEYS {
        let info = crate::legacy_entities::get_legacy_entity_info(name)
            .unwrap_or_else(|| panic!("{name} has no arm in legacy_entities.rs"));
        assert!(
            !matches!(info.base_type, IfcType::Unknown(_)),
            "{name} maps to Unknown, which is the same as not being in the table"
        );
        if info.has_geometry {
            assert!(
                info.base_type.is_subtype_of(IfcType::IfcProduct),
                "{name} claims geometry but its base type is not an IfcProduct"
            );
        }
    }
}

/// `legacy_aware_ifc_type_from_record` — the resolution the wasm mesh batch
/// needs and did not have (#3179).
///
/// The browser path holds a `DecodedEntity` whose `ifc_type` came from a bare
/// `from_str`, plus the raw record. For a legacy keyword that field is
/// `Unknown`, and `Unknown` stores a CRC32 hash rather than the name, so the
/// keyword survives only in the record.
///
/// The keywords here all predate #3172, which has since landed and wrote six
/// arms, one of them replacing a misspelling (the table went 21 -> 26). They
/// are kept because what this test exercises is the WIRE-UP --
/// that a record reaches `legacy_entities.rs` at all -- not the table's
/// contents, which `legacy_ifc2x3_products_resolve_to_their_own_supertype`
/// above covers directly. Choosing rows that do not move keeps the two tests
/// from failing together for one cause.
#[test]
fn a_legacy_record_resolves_where_the_decoded_type_cannot() {
    // What the decoder produces for these, and what the browser was emitting.
    //
    // The SPACED forms are not padding. STEP permits whitespace around `=` and
    // buildingSMART's own `column-straight-rectangle-tessellation.ifc` writes
    // `#71= IFCCOLUMN(` on all 26 of its entity lines. The first draft of this
    // test used only the tight form, passed, and the end-to-end wasm check then
    // failed on the real fixture -- `extract_entity_type_name` was returning
    // `" IFCCOLUMN"` untrimmed and every entity in such a file resolved to
    // `Unknown`. A hand-written record is a weaker fixture than a real one.
    for (record, expected) in [
        (&b"#12=IFCPROXY('guid',$,$,$,$,$,$,$,$);"[..], IfcType::IfcBuildingElementProxy),
        (&b"#13=IFCSLABSTANDARDCASE('guid',$,$,$,$,$,$,$,$);"[..], IfcType::IfcSlab),
        (&b"#14=IFCDOORSTANDARDCASE('guid',$,$,$,$,$,$,$,$);"[..], IfcType::IfcDoor),
        (&b"#15=IFCSOLIDSTRATUM('guid',$,$,$,$,$,$,$,$);"[..], IfcType::IfcGeotechnicalStratum),
        // Whitespace around `=`, both sides, as real exporters emit it.
        (&b"#16= IFCPROXY('guid',$,$,$,$,$,$,$,$);"[..], IfcType::IfcBuildingElementProxy),
        (&b"#17 = IFCSLABSTANDARDCASE('guid',$,$);"[..], IfcType::IfcSlab),
        (&b"#18=\tIFCDOORSTANDARDCASE('guid',$,$);"[..], IfcType::IfcDoor),
    ] {
        let name = crate::fast_parse::extract_entity_type_name(record).unwrap();
        let decoded = IfcType::from_str(name);
        assert!(
            matches!(decoded, IfcType::Unknown(_)),
            "{name} must be Unknown to the bare decoder, or this test proves nothing"
        );
        assert_eq!(legacy_aware_ifc_type_from_record(decoded, record), expected, "{name}");
    }
}

/// A type the decoder already knows is returned UNCHANGED and without a scan,
/// so the cost falls only on the entities that need it -- and, more to the
/// point, so a malformed record cannot relabel a known entity.
#[test]
fn a_known_type_is_returned_untouched_whatever_the_record_says() {
    let wall = IfcType::from_str("IFCWALL");
    assert!(!matches!(wall, IfcType::Unknown(_)));
    // Record deliberately disagrees with the decoded type; the decoded type wins.
    assert_eq!(
        legacy_aware_ifc_type_from_record(wall, b"#1=IFCSLABSTANDARDCASE('g');"),
        IfcType::IfcWall
    );
}

/// An unreadable record leaves the answer exactly as the decoder had it, rather
/// than inventing one. `Unknown` in, `Unknown` out -- the entity is no worse off
/// than before this function existed.
#[test]
fn an_unreadable_record_changes_nothing() {
    let unknown = IfcType::from_str("IFCNOTAREALENTITY");
    assert!(matches!(unknown, IfcType::Unknown(_)));
    for record in [&b""[..], &b"garbage with no equals or paren"[..], &b"#1="[..], &b"#1=("[..]] {
        assert_eq!(legacy_aware_ifc_type_from_record(unknown, record), unknown);
    }
}

/// #3187 -- the COMPLETE set of keywords whose type-product classification the
/// legacy-aware predicate changes, enumerated rather than sampled.
///
/// `type_product_ifc_type` replaced a bare
/// `IfcType::from_str(kw).is_subtype_of(IfcTypeProduct)` at six gates at once,
/// so the honest question is not "does IfcDoorStyle work now" but "what ELSE
/// did those gates start admitting". Sweeping the whole generated catalog plus
/// the whole legacy table answers it: the two expressions agree everywhere
/// except the three IFC2X3 type products IFC4X3 dropped. `legacy_aware_ifc_type`
/// falls through to `from_str` for anything the legacy table does not name, so
/// a schema entity's answer cannot change; only a legacy keyword's can.
#[test]
fn the_legacy_aware_type_product_gate_widens_by_exactly_three_keywords() {
    const EXPECTED_NEW: [(&str, IfcType); 3] = [
        ("IFCDOORSTYLE", IfcType::IfcDoorType),
        ("IFCWINDOWSTYLE", IfcType::IfcWindowType),
        ("IFCBUILDINGELEMENTTYPE", IfcType::IfcBuiltElementType),
    ];

    // The pre-fix expression, kept verbatim so the two can be compared.
    fn bare_gate(kw: &str) -> bool {
        (kw.ends_with("TYPE") || kw.ends_with("STYLE"))
            && IfcType::from_str(kw).is_subtype_of(IfcType::IfcTypeProduct)
    }

    // The whole legacy table, walked -- not a hand-copy of it. A hand-copied
    // list can only assert the cheap direction (every listed name is legacy)
    // and stays green when the table grows a name the list omits, which is
    // exactly the case that widens these six gates without anyone noticing.
    // `LEGACY_ENTITY_NAMES` is re-derived from the match arms by
    // `legacy_entities::legacy_entity_name_tests::legacy_entity_names_match_the_lookup_arms`,
    // so a new arm reaches this sweep and, if it is a `TYPE`/`STYLE` name,
    // reds the widening-set assertion below.
    let legacy = crate::LEGACY_ENTITY_NAMES.iter().copied();

    let mut widened: Vec<(&str, IfcType)> = Vec::new();
    let names: Vec<String> = crate::IFC_TYPES
        .iter()
        .map(|t: &IfcType| t.name().to_uppercase())
        .collect();
    for kw in names.iter().map(String::as_str).chain(legacy) {
        match (bare_gate(kw), type_product_ifc_type(kw)) {
            (false, Some(ty)) => widened.push((kw, ty)),
            (true, Some(ty)) => assert_eq!(
                ty,
                IfcType::from_str(kw),
                "{kw} was already admitted; its resolved type must not have moved"
            ),
            (true, None) => panic!("{kw}: the legacy-aware gate NARROWED, dropping geometry"),
            (false, None) => {}
        }
    }

    // Compared as sets (both sides sorted): the sweep's order follows
    // `LEGACY_ENTITY_NAMES`, and reordering that const is not a defect.
    widened.sort_by_key(|&(kw, _)| kw);
    let mut expected = EXPECTED_NEW.to_vec();
    expected.sort_by_key(|&(kw, _)| kw);
    assert_eq!(widened, expected, "unexpected widening set");

    for (kw, _) in EXPECTED_NEW {
        // No double-render: none of the three is also an ordinary geometry job.
        assert!(!has_geometry_by_name(kw), "{kw} would render twice");
        // Nor an ordinary product row in the attribute export's pass 2.
        assert!(
            !legacy_aware_ifc_type(kw).is_subtype_of(IfcType::IfcProduct),
            "{kw} would get both a product row and a type-product row"
        );
    }
}

/// The unstated invariant `legacy_aware_ifc_type_from_record` rests on.
///
/// That function short-circuits on `!matches!(decoded, IfcType::Unknown(_))`,
/// which is only equivalent to `legacy_aware_ifc_type` while every key in the
/// legacy table is a name the generated enum does NOT know. If a schema
/// regeneration ever emits an arm for one of these keys -- and several are real
/// IFC2x3/IFC4 entities, `IFCPRESENTATIONSTYLEASSIGNMENT` among them --
/// `from_str` stops returning `Unknown`, the early return fires, and the wasm
/// path silently returns the raw variant while the native path still remaps it.
/// That is exactly the wasm-vs-native divergence #3179 was filed for, and it
/// would come back in a form no other test here observes.
///
/// `every_legacy_arm_maps_onto_a_known_product` asserts the BASE TYPE is known.
/// This asserts the KEY is not: the opposite direction, and the one the
/// short-circuit depends on.
///
/// This is the BEHAVIOURAL half -- it calls `from_str` for real, where
/// `scripts/check-legacy-entity-coverage.mjs` compares the two sets as source
/// text. Coverage is not this test's own doing either way: `LEGACY_KEYS` is
/// `LEGACY_ENTITY_NAMES`, which that lint holds equal to the match arms in
/// both directions, so a 27th arm reaches this loop or the lint goes red.
/// It did neither while this list was a hand-written copy.
#[test]
fn every_legacy_key_is_unknown_to_the_generated_enum() {
    for &key in LEGACY_KEYS {
        assert!(
            matches!(IfcType::from_str(key), IfcType::Unknown(_)),
            "{key} is now known to `IfcType::from_str`, so the `Unknown` \
             short-circuit in `legacy_aware_ifc_type_from_record` skips its \
             legacy remap and the browser diverges from the native path again"
        );
    }
}

