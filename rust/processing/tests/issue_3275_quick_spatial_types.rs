// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3275 — the fast-boot spatial tree's type gate must come from the
//! schema, not from a hand-written list.
//!
//! `is_quick_spatial_type_ci` decides which entities become nodes in the
//! bootstrap spatial tree (`processor::mod`'s scan loop). It used to hand-list
//! fourteen names, and a hand list can only ever be as complete as whoever
//! last audited the schema: it was missing `IfcMarineFacility`,
//! `IfcMarinePart` and `IfcFacilityPartCommon`, so an IFC4.3 harbour lost its
//! whole branch from the tree the user sees first.
//!
//! Two tests, and the second is the one that matters:
//!
//!   - `marine_branch_reaches_the_fast_boot_tree` is the end-to-end
//!     reproduction from the issue, through the real bootstrap path.
//!   - `quick_spatial_gate_matches_the_schema` re-derives the expected answer
//!     for **every** type in `ifc_lite_core::IFC_TYPES` from the generated
//!     inheritance table and compares name by name. It is deliberately NOT a
//!     comparison against the TypeScript list: two hand lists agreeing with
//!     each other is exactly what hid this defect for three releases. The
//!     TypeScript half (`packages/data/src/spatial-types.test.ts`) is anchored
//!     to its own generated schema table the same way, so neither side can
//!     drift without its own gate reddening.

use ifc_lite_core::{IfcType, IFC_TYPES};
use ifc_lite_processing::{
    is_quick_spatial_type_ci, process_geometry_streaming_with_options_and_bootstrap,
    QuickMetadataBootstrap, QuickMetadataSpatialNode, StreamingOptions,
};
use std::collections::BTreeSet;

const MARINE_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3275 marine facility fixture'),'2;1');
FILE_NAME('marine.ifc','2026-08-25T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('3Project00000000003275',$,'Harbour',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);

#20=IFCSITE('3Site0000000000003275',$,'Site',$,$,#7,$,$,.ELEMENT.,$,$,$,$,$);
#21=IFCMARINEFACILITY('3MarineFac0000003275',$,'Port',$,$,#7,$,$,.ELEMENT.,.PORT.);
#22=IFCMARINEPART('3MarinePart000003275',$,'Quay',$,$,#7,$,$,.PARTIAL.,.LATERAL.,.QUAY.);
#30=IFCFACILITY('3Facility00000003275',$,'Terminal',$,$,#7,$,$,.ELEMENT.);
#31=IFCFACILITYPARTCOMMON('3FacPartCommon003275',$,'Wing A',$,$,#7,$,$,.PARTIAL.,.LATERAL.,.SEGMENT.);

#40=IFCRELAGGREGATES('3RelAggProjSite03275',$,$,$,#1,(#20));
#41=IFCRELAGGREGATES('3RelAggSiteMar003275',$,$,$,#20,(#21,#30));
#42=IFCRELAGGREGATES('3RelAggMarPart003275',$,$,$,#21,(#22));
#43=IFCRELAGGREGATES('3RelAggFacPart003275',$,$,$,#30,(#31));
ENDSEC;
END-ISO-10303-21;
"#;

fn flatten(node: &QuickMetadataSpatialNode, out: &mut Vec<(u32, String)>) {
    out.push((
        node.summary.express_id,
        node.summary.type_name.to_ascii_uppercase(),
    ));
    for child in &node.children {
        flatten(child, out);
    }
}

#[test]
fn marine_branch_reaches_the_fast_boot_tree() {
    let mut captured: Option<QuickMetadataBootstrap> = None;
    let options = StreamingOptions {
        emit_quick_metadata_bootstrap: true,
        ..Default::default()
    };
    process_geometry_streaming_with_options_and_bootstrap(
        MARINE_IFC.as_bytes(),
        options,
        |_, _, _| {},
        |_| {},
        |b| captured = Some(b.clone()),
    );

    let boot = captured.expect("a quick-metadata bootstrap should be emitted");
    let tree = boot.spatial_tree.expect("a spatial tree should be built");

    let mut seen = Vec::new();
    flatten(&tree, &mut seen);
    let ids: BTreeSet<u32> = seen.iter().map(|(id, _)| *id).collect();

    // Named, not counted: a floor of "at least four nodes" survives dropping
    // the quay, which is the entity this issue is about.
    for (id, name) in [
        (1u32, "IFCPROJECT"),
        (20, "IFCSITE"),
        (21, "IFCMARINEFACILITY"),
        (22, "IFCMARINEPART"),
        (30, "IFCFACILITY"),
        (31, "IFCFACILITYPARTCOMMON"),
    ] {
        assert!(
            ids.contains(&id),
            "{name} #{id} must be a node in the fast-boot spatial tree; got {seen:?}"
        );
    }
}

/// The gate's answer, re-derived from the generated inheritance table.
///
/// `IfcProject` is the tree root and is an `IfcObject`, not a spatial element
/// at all. Everything else is the whole `IfcSpatialElement` branch except the
/// external-spatial sub-branch — the rule #3247 pinned in the unit test beside
/// the gate, restated here against the same generated table. `IfcSpatialZone`
/// sits inside that branch and outside `IfcSpatialStructureElement`; it is
/// carried deliberately (#1075, Revit/Dynamo GFA volumes).
fn schema_says_spatial(t: IfcType) -> bool {
    t == IfcType::IfcProject
        || (t.is_subtype_of(IfcType::IfcSpatialElement)
            && !t.is_subtype_of(IfcType::IfcExternalSpatialStructureElement))
}

#[test]
fn quick_spatial_gate_matches_the_schema() {
    let mut expected = BTreeSet::new();
    let mut mismatches = Vec::new();
    for &t in IFC_TYPES {
        let want = schema_says_spatial(t);
        if want {
            expected.insert(t.as_str());
        }
        let got = is_quick_spatial_type_ci(t.as_str());
        if got != want {
            mismatches.push(format!("{}: gate={got} schema={want}", t.as_str()));
        }
    }

    // Anti-vacuity: the sweep must actually have run over the whole catalog,
    // and the derived expectation must be non-trivial. A renamed supertype
    // would otherwise make every assertion below pass over an empty set.
    assert!(
        IFC_TYPES.len() > 800,
        "IFC_TYPES looks truncated ({} entries)",
        IFC_TYPES.len()
    );
    for required in [
        "IFCPROJECT",
        "IFCSITE",
        "IFCBUILDING",
        "IFCBUILDINGSTOREY",
        "IFCSPACE",
        "IFCSPATIALZONE",
        "IFCFACILITY",
        "IFCFACILITYPART",
        "IFCFACILITYPARTCOMMON",
        "IFCBRIDGE",
        "IFCBRIDGEPART",
        "IFCROAD",
        "IFCROADPART",
        "IFCRAILWAY",
        "IFCRAILWAYPART",
        "IFCMARINEFACILITY",
        "IFCMARINEPART",
    ] {
        assert!(
            expected.contains(required),
            "the schema-derived expectation lost {required}; the derivation, not the gate, \
             is broken"
        );
    }

    assert!(
        mismatches.is_empty(),
        "the fast-boot spatial gate disagrees with the generated schema for {} type(s): {:?}",
        mismatches.len(),
        mismatches
    );
}

#[test]
fn non_spatial_types_stay_out_of_the_tree() {
    // The other direction. `IfcExternalSpatialElement` is the interesting one:
    // it IS an `IfcSpatialElement`, but it sits under
    // `IfcExternalSpatialStructureElement` (`IFC4X3.exp:6570-6574`), outside the
    // `IfcSpatialStructureElement` branch, and carries no `WR41` aggregation
    // rule — it is a space *boundary* volume (external air, ground), never a
    // member of the containment hierarchy. Admitting it would add a permanently
    // parentless node to the tree. It is excluded on both sides on purpose.
    for name in [
        "IFCWALL",
        "IFCBUILDINGELEMENTPROXY",
        "IFCZONE",
        "IFCEXTERNALSPATIALELEMENT",
        "IFCEXTERNALSPATIALSTRUCTUREELEMENT",
        // The abstract supertypes ABOVE the branch. `IfcSpatialElement` itself
        // is deliberately absent from this list: it is the branch root, so the
        // rule admits it, and being abstract it never appears as a STEP keyword.
        "IFCPRODUCT",
        "IFCOBJECT",
        "IFCROOT",
        // Not an entity in any bundled schema.
        "IFCNOTATHING",
    ] {
        assert!(
            !is_quick_spatial_type_ci(name),
            "{name} must not be treated as a fast-boot spatial node"
        );
    }

    // Case-insensitivity is part of the contract — STEP keywords are uppercase
    // by convention, not by rule.
    assert!(is_quick_spatial_type_ci("IfcMarinePart"));
    assert!(is_quick_spatial_type_ci("ifcbuildingstorey"));
}
