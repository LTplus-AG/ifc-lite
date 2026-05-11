// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Integration tests for the "merge multilayer wall as single solid" toggle
//! (issue #540).
//!
//! The actual JS-facing flag lives in `ifc-lite-wasm::api::IfcAPI` and isn't
//! exercised here — building a wasm-bindgen-test for it would require a
//! browser runtime. Instead these tests cover the two Rust ingredients the
//! WASM layer composes:
//!
//! 1. `propagate_voids_to_parts` returns a `part → parent` map covering every
//!    emitted `IfcBuildingElementPart` whose parent has its own
//!    `Representation`.
//! 2. `MaterialLayerIndex::is_sliceable(parent_id)` is `true` exactly when the
//!    parent wall has a planar `IfcMaterialLayerSetUsage` buildup — which is
//!    the condition the WASM layer filters on before adding a part to the
//!    skip set.
//!
//! Composing those two yields the same `parts_to_skip` set that
//! `parseMeshes*` use, so the toggle's overall correctness reduces to these
//! two unit-level guarantees.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{propagate_voids_to_parts, MaterialLayerIndex};
use rustc_hash::{FxHashMap, FxHashSet};

/// Multilayer wall:
///  - parent `IfcWall` #100 with its own representation (#51)
///  - three layer parts #101..#103, each with a representation
///  - `IfcMaterialLayerSetUsage` (#221) → 3-layer `IfcMaterialLayerSet`
///  - `IfcRelAssociatesMaterial` connects #100 → #221 so the parent is
///    Sliceable in `MaterialLayerIndex`.
///  - `IfcRelAggregates` decomposes #100 → (#101, #102, #103)
fn sliceable_multilayer_wall_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
#100=IFCWALL('0001wall',$,'Parent',$,$,$,#51,$,$);
#101=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#102=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);
#103=IFCBUILDINGELEMENTPART('0001p03',$,'L2',$,$,$,#51,$,$);
#200=IFCMATERIAL('Finish',$,$);
#201=IFCMATERIAL('Core',$,$);
#210=IFCMATERIALLAYER(#200,0.05,$,'FinishOuter',$,$,$);
#211=IFCMATERIALLAYER(#201,0.2,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#200,0.05,$,'FinishInner',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'3LayerBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);
#300=IFCRELASSOCIATESMATERIAL('0001ram',$,$,$,(#100),#221);
#310=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#101,#102,#103));
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// Same shape, but the material relation points at an `IfcMaterial` rather
/// than an `IfcMaterialLayerSetUsage`. The parent has its own representation
/// but is NOT Sliceable → no parts should end up in the skip set.
fn nonsliceable_aggregate_wall_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#40=IFCEXTRUDEDAREASOLID($,$,$,3.0);
#100=IFCWALL('0001wall',$,'Parent',$,$,$,#51,$,$);
#101=IFCBUILDINGELEMENTPART('0001p01',$,'L0',$,$,$,#51,$,$);
#102=IFCBUILDINGELEMENTPART('0001p02',$,'L1',$,$,$,#51,$,$);
#200=IFCMATERIAL('Concrete',$,$);
#300=IFCRELASSOCIATESMATERIAL('0001ram',$,$,$,(#100),#200);
#310=IFCRELAGGREGATES('0001ra',$,$,$,#100,(#101,#102));
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// Compose the skip set the same way the WASM layer does.
fn build_skip_set(content: &str) -> FxHashSet<u32> {
    let mut decoder = EntityDecoder::new(content);
    let material_layer_index = MaterialLayerIndex::from_content(content, &mut decoder);
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let part_to_parent = propagate_voids_to_parts(&mut void_index, content, &mut decoder);

    part_to_parent
        .iter()
        .filter(|(_, parent_id)| material_layer_index.is_sliceable(**parent_id))
        .map(|(part_id, _)| *part_id)
        .collect()
}

#[test]
fn skip_set_includes_all_parts_when_parent_is_sliceable() {
    let content = sliceable_multilayer_wall_ifc();
    let skip = build_skip_set(&content);

    assert_eq!(
        skip.len(),
        3,
        "expected all 3 layer parts in skip set, got {:?}",
        skip
    );
    assert!(skip.contains(&101));
    assert!(skip.contains(&102));
    assert!(skip.contains(&103));
    // Parent itself MUST NOT be skipped — it carries the merged solid.
    assert!(!skip.contains(&100));
}

#[test]
fn skip_set_is_empty_when_parent_is_not_sliceable() {
    let content = nonsliceable_aggregate_wall_ifc();
    let skip = build_skip_set(&content);

    assert!(
        skip.is_empty(),
        "expected empty skip set for non-sliceable parent, got {:?}",
        skip
    );
}
