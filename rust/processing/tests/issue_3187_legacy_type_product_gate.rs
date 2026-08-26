// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3187 — the type-geometry candidate gates classify with a bare
//! `IfcType::from_str`, against the rule `schema_helpers.rs` states.
//!
//! `IFCDOORSTYLE` and `IFCWINDOWSTYLE` are IFC2X3 `IfcTypeProduct` subtypes
//! that IFC4X3 dropped, so the bare `from_str` this crate's schema is derived
//! from returns `IfcType::Unknown`, `Unknown` is a subtype of nothing, and the
//! entity is discarded before it can become a job. They also carry
//! `has_geometry: false` in `legacy_entities.rs`, so the ordinary product route
//! never reaches them either — their `RepresentationMaps` geometry is silently
//! dropped from every path.

use ifc_lite_core::{has_geometry_by_name, legacy_aware_ifc_type, IfcType};
use ifc_lite_processing::{
    classify_type_name, process_geometry, PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
};

/// An IFC2X3 `IfcDoorStyle` whose tessellated tetrahedron hangs off a
/// `RepresentationMap` with no occurrence and no `IfcMappedItem` — the exact
/// shape #957 renders for a modern `IfcDoorType`.
const LEGACY_DOOR_STYLE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3187 legacy type-only geometry'),'2;1');
FILE_NAME('t.ifc','2026-08-25T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCDOORSTYLE('2n5ASfQfT84eP9h$zLLJ4A',$,'Door',$,$,$,(#44),$,.NOTDEFINED.,.NOTDEFINED.,.F.,.F.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn legacy_door_style_orphan_representation_map_renders() {
    let result = process_geometry(LEGACY_DOOR_STYLE_IFC);

    let type_meshes: Vec<&_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == 43)
        .collect();
    assert_eq!(
        type_meshes.len(),
        1,
        "IFC2X3 IfcDoorStyle #43 carries an orphan RepresentationMap and must render \
         exactly one mesh, like the IfcDoorType it maps to; got {:?}",
        result
            .meshes
            .iter()
            .map(|m| (m.express_id, m.ifc_type.as_str()))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        type_meshes[0].indices.len() / 3,
        4,
        "tetrahedron should produce 4 triangles"
    );
}

/// The sharded browser-load path reads a precomputed class byte instead of
/// re-deriving the gate, so it needs its own pin.
#[test]
fn legacy_type_keywords_set_the_shard_type_candidate_flag() {
    for name in ["IFCDOORSTYLE", "IFCWINDOWSTYLE", "IFCBUILDINGELEMENTTYPE"] {
        assert_eq!(
            classify_type_name(name) & PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
            PREPASS_CLASS_FLAG_TYPE_CANDIDATE,
            "{name} resolves to {:?}, an IfcTypeProduct subtype, so the sharded scan \
             must flag it as a type-geometry candidate",
            legacy_aware_ifc_type(name)
        );
    }
}

/// The complete set of legacy keywords the widened gate newly admits, and the
/// reason widening it cannot double-count: every one of them is refused by
/// `has_geometry_by_name`, so none is also scheduled as an ordinary product.
///
/// Enumerated, not sampled: the `ends_with("TYPE") || ends_with("STYLE")`
/// pre-filter admits only these three entries of the legacy table, and
/// `IFCPRESENTATIONSTYLEASSIGNMENT` (the only other legacy `*STYLE*` name) does
/// not end in either suffix.
///
/// NOT a guard on the six gates #3187 rewired, and it should not be read as
/// one. It asserts only over `legacy_aware_ifc_type`, `IfcType::from_str` and
/// `has_geometry_by_name` -- three functions #3187 leaves untouched -- and it
/// stays green under the mutation that reds the tests above (maintainer review
/// of #3190, confirmed by re-running it). What it does guard is
/// `legacy_entities.rs`: flip `has_geometry` to `true` on any of the three, or
/// move a base type, and the widened gates would start double-rendering; this
/// reddens first. The gates themselves are pinned by the other tests in this
/// file, by `schema_helpers_tests.rs`'s widening sweep, and by the per-site
/// tests in `export` and `wasm-bindings`.
#[test]
fn newly_admitted_legacy_type_candidates_are_never_also_geometry_jobs() {
    let newly_admitted = [
        ("IFCDOORSTYLE", IfcType::IfcDoorType),
        ("IFCWINDOWSTYLE", IfcType::IfcWindowType),
        ("IFCBUILDINGELEMENTTYPE", IfcType::IfcBuiltElementType),
    ];
    for (name, expected) in newly_admitted {
        assert_eq!(legacy_aware_ifc_type(name), expected, "{name}");
        assert!(
            !IfcType::from_str(name).is_subtype_of(IfcType::IfcTypeProduct),
            "{name} must be one the BARE resolver drops, or this test pins nothing"
        );
        assert!(
            legacy_aware_ifc_type(name).is_subtype_of(IfcType::IfcTypeProduct),
            "{name} must be admitted by the legacy-aware resolver"
        );
        assert!(
            !has_geometry_by_name(name),
            "{name} must NOT also be an ordinary geometry job, or widening the type \
             gate would render its geometry twice"
        );
    }
}
