// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #860 — IFC4.3's concrete stratum subtypes
//! must be recognised as geometry-bearing IfcGeotechnicalStratum even
//! though the auto-generated schema enum only exposes the abstract base.
//!
//! Pre-fix: `has_geometry_by_name("IFCSOLIDSTRATUM")` returned `false`,
//! and the wasm geometry pipeline silently skipped every stratum element
//! in the user's UT_Tin_in_MGA_56 terrain fixture.

use ifc_lite_core::{
    has_geometry_by_name,
    legacy_entities::{get_legacy_entity_info, map_legacy_to_base_type},
    IfcType,
};

#[test]
fn solid_stratum_recognised_as_geotechnical_stratum() {
    let info = get_legacy_entity_info("IFCSOLIDSTRATUM")
        .expect("IFCSOLIDSTRATUM must be in the legacy registry");
    assert_eq!(info.base_type, IfcType::IfcGeotechnicalStratum);
    assert!(info.has_geometry, "stratum elements carry Body geometry");
}

#[test]
fn void_and_water_strata_are_also_geotechnical_stratum() {
    for name in &["IFCVOIDSTRATUM", "IFCWATERSTRATUM"] {
        let info = get_legacy_entity_info(name)
            .unwrap_or_else(|| panic!("{name} must be in the legacy registry"));
        assert_eq!(info.base_type, IfcType::IfcGeotechnicalStratum);
        assert!(info.has_geometry);
    }
}

#[test]
fn has_geometry_by_name_passes_for_all_stratum_subtypes() {
    for name in &["IFCSOLIDSTRATUM", "IFCVOIDSTRATUM", "IFCWATERSTRATUM"] {
        assert!(
            has_geometry_by_name(name),
            "{name} must report has_geometry=true; pre-fix it returned false \
             and the wasm pipeline silently dropped every stratum element \
             from the spatial tree (issue #860)."
        );
    }
}

#[test]
fn map_legacy_to_base_type_returns_geotechnical_stratum() {
    assert_eq!(
        map_legacy_to_base_type("IFCSOLIDSTRATUM"),
        Some(IfcType::IfcGeotechnicalStratum),
    );
}
