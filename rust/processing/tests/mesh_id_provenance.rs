// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3199 — which entity a [`MeshData`] names, and how a host can trust it.
//!
//! A mesh carries EITHER `geometry_item_id` (the `IfcRepresentationItem` it was
//! tessellated from) OR `material_id` (the `IfcMaterial` whose layer it is
//! a slice of), never both. Before #3199 the material id rode in
//! `geometry_item_id`, so following the field on a layered wall landed on an
//! `IfcMaterial` with nothing to warn the caller.
//!
//! The sharp edge these tests exist for is
//! [`sliceable_wall_that_did_not_slice_keeps_representation_item_ids`]:
//! `geometry_class == 3` is stamped from `is_material_layer_sliceable`, a static
//! index lookup, BEFORE the geometry runs. The slicer can still bail, and then
//! the element emits ordinary representation-item sub-meshes under class 3. So
//! the class cannot answer which id a mesh carries, and anything that derives
//! the answer from it re-creates exactly the lie #3199 removed.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex};
use ifc_lite_processing::element::{
    GEOM_CLASS_LAYER_SLICE,
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::{process_geometry, MeshData};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// A three-layer wall (50 mm finish / 200 mm core / 50 mm finish, materials
/// #200/#201/#200) whose body representation holds `items`.
///
/// One item slices; two items do not — `try_layered_sub_meshes` requires a
/// single unshifted item, because the layer planes are built from the element
/// placement alone and would otherwise sit in a different frame than the mesh.
/// Everything else about the two files is identical, so the two tests below
/// differ in exactly the thing under test.
fn three_layer_wall(items: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3199 layered wall'),'2;1');
FILE_NAME('wall.ifc','2026-08-25T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',$,'Test',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'WallA',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#44=IFCRECTANGLEPROFILEDEF(.AREA.,'WallB',#45,2.0,0.3);
#45=IFCAXIS2PLACEMENT2D(#46,#47);
#46=IFCCARTESIANPOINT((5.,0.));
#47=IFCDIRECTION((1.,0.));
#48=IFCEXTRUDEDAREASOLID(#44,#41,#42,3.0);
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',({items}));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',$,'TestWall',$,$,#20,#51,'Test',$);
#200=IFCMATERIAL('Finish',$,$);
#201=IFCMATERIAL('Core',$,$);
#210=IFCMATERIALLAYER(#200,0.05,$,'FinishOuter',$,$,$);
#211=IFCMATERIALLAYER(#201,0.2,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#200,0.05,$,'FinishInner',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'3LayerBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456790',$,$,$,(#100),#221);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// The same wall with its MIDDLE layer turned into an AIR GAP: `#211`'s
/// `Material` reference is `$`, which the schema permits —
/// `IfcMaterialLayer.Material` is OPTIONAL and a ventilated cavity is the
/// canonical reason to leave it out.
///
/// `material_layer_index.rs` reads it as `layer.get_ref(0).unwrap_or(0)`, so
/// that layer reaches the slicer with `material_id == 0`. `0` is that
/// function's "no reference" sentinel, NOT an entity: STEP instance names start
/// at `#1`. Emitting it would make the slab claim to be a slice of
/// `IfcMaterial #0` and send a host following the id to nothing at all.
fn three_layer_wall_with_air_gap(items: &str) -> String {
    let s = three_layer_wall(items);
    let with_gap = s.replace(
        "#211=IFCMATERIALLAYER(#201,0.2,$,'Core',$,$,$);",
        "#211=IFCMATERIALLAYER($,0.2,$,'AirGap',$,$,$);",
    );
    assert_ne!(with_gap, s, "the air-gap substitution did not apply");
    with_gap
}

/// Mesh wall #100 through `produce_element_meshes` with the router's
/// `MaterialLayerIndex` wired — the arming the native pipeline
/// (`processor/mod.rs`) and the wasm batch path both do. Returns the meshes and
/// whether the index called the wall sliceable.
fn produce_wall(content: &str) -> (Vec<MeshData>, bool) {
    let mut decoder = EntityDecoder::new(content);
    let mut router = GeometryRouter::with_units(content, &mut decoder);
    let index = MaterialLayerIndex::from_content(content, &mut decoder);
    let sliceable = index.is_sliceable(100);
    router.set_material_layer_index(Arc::new(index));

    let wall = decoder.decode_by_id(100).expect("decode wall #100");
    let void_index = FxHashMap::default();
    let geometry_style_index = FxHashMap::default();
    let indexed_colour_full = FxHashMap::default();
    let element_material_colors = FxHashMap::default();
    let texture_index = FxHashMap::default();
    let ctx = MeshProductionContext {
        void_index: &void_index,
        geometry_style_index: &geometry_style_index,
        indexed_colour_full: &indexed_colour_full,
        element_material_colors: &element_material_colors,
        texture_index: &texture_index,
        site_local_rotation: None,
    };
    let job = ElementMeshJob {
        id: 100,
        ifc_type: IfcType::IfcWall,
        entity: &wall,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };

    let produced = produce_element_meshes(
        &job,
        &ctx,
        &MeshProductionOptions::default(),
        &mut decoder,
        &router,
    );
    (produced.meshes, sliceable)
}

/// The contract's one unconditional rule, checked wherever meshes are produced.
fn assert_ids_disjoint(meshes: &[MeshData], what: &str) {
    for m in meshes {
        assert!(
            !(m.geometry_item_id.is_some() && m.material_id.is_some()),
            "[{what}] mesh of #{} carries BOTH geometry_item_id {:?} and material_id {:?}",
            m.express_id,
            m.geometry_item_id,
            m.material_id
        );
    }
}

fn geometry_fixture(name: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../geometry/tests/fixtures")
        .join(name);
    // PANIC rather than skip. These fixtures are TRACKED IN GIT -- `pnpm
    // fixtures` does not fetch them and nothing else can remove them -- so a
    // missing one is a broken checkout, not an unavailable corpus. Returning
    // `Option` and letting the caller `return` turned that into a test that
    // passed by asserting nothing, in the one file whose whole job is pinning
    // provenance. Absence must not read as success (#3199).
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "fixture {} is tracked in git; restore it with `git checkout -- {}`: {e}",
            path.display(),
            path.display()
        )
    })
}

/// Every slab of a sliced layered wall names its `IfcMaterial` and nothing else.
///
/// Regresses to the pre-#3199 lie if `material_id` stops being routed:
/// the material ids would reappear in `geometry_item_id`, where a host following
/// the field to source lands on `IfcMaterial` #200 instead of a geometry item.
#[test]
fn layered_wall_slices_name_their_material_not_a_representation_item() {
    let content = three_layer_wall("#40");
    let (meshes, sliceable) = produce_wall(&content);
    assert!(sliceable, "the layer index must call this wall sliceable");
    assert_ids_disjoint(&meshes, "sliced layered wall");

    assert_eq!(meshes.len(), 3, "expected one mesh per layer");
    for m in &meshes {
        assert_eq!(m.geometry_class, GEOM_CLASS_LAYER_SLICE);
        assert_eq!(
            m.geometry_item_id, None,
            "a layer slab is not a representation item, got {:?}",
            m.geometry_item_id
        );
    }

    // #200 Finish, #201 Core, #200 Finish — in stack order, the two outer
    // finishes sharing one material. Named, not `is_some()`: a slab pointing at
    // the wrong material is the failure a presence check would pass.
    let materials: Vec<Option<u32>> = meshes.iter().map(|m| m.material_id).collect();
    assert_eq!(
        materials,
        vec![Some(200), Some(201), Some(200)],
        "layer slabs must name the buildup's materials in stack order"
    );
}

/// THE #3199 sharp edge: `geometry_class == 3` on meshes that are representation
/// items, because the class is stamped from the static
/// `is_material_layer_sliceable` lookup while the slicer bails at runtime.
///
/// Same wall, same layer set, one extra body item — which
/// `element_is_single_unshifted_item` refuses, so the element falls through to
/// the ordinary sub-mesh path and emits #40 and #48.
///
/// This is the test that catches deriving the item-vs-layer answer from
/// `geometry_class` (or from `is_material_layer_sliceable`): both say "layer"
/// here, and both are wrong. Without it, such a change looks green.
#[test]
fn sliceable_wall_that_did_not_slice_keeps_representation_item_ids() {
    let content = three_layer_wall("#40,#48");
    let (meshes, sliceable) = produce_wall(&content);
    assert!(
        sliceable,
        "the static index must still call this wall sliceable — that is the trap"
    );
    assert_ids_disjoint(&meshes, "sliceable wall that did not slice");

    assert_eq!(
        meshes.len(),
        2,
        "expected the two body items, not layer slabs"
    );
    for m in &meshes {
        assert_eq!(
            m.geometry_class, GEOM_CLASS_LAYER_SLICE,
            "the class is stamped before the geometry runs, so it must still be 3 here"
        );
        assert_eq!(
            m.material_id, None,
            "no layer was cut, so nothing may claim to be a material slice"
        );
    }

    let mut items: Vec<Option<u32>> = meshes.iter().map(|m| m.geometry_item_id).collect();
    items.sort();
    assert_eq!(
        items,
        vec![Some(40), Some(48)],
        "each mesh must name the IfcExtrudedAreaSolid it came from"
    );
}

/// #3199 — pins WHICH id a mapped item's meshes carry: the solid inside the
/// `IfcRepresentationMap`, not the `IfcMappedItem` and not the map.
///
/// Four occurrences share map #18 over solids #11 and #15. Each occurrence
/// emits both solid ids, so the id identifies the SOURCE geometry and repeats
/// across occurrences — it is not an occurrence-unique handle. A future change
/// to per-occurrence ids should be deliberate, and this fails when it is not.
#[test]
fn mapped_item_meshes_name_the_solid_inside_the_map() {
    let content = geometry_fixture("mapped_instances_multi_item.ifc");
    let result = process_geometry(&content);
    assert_ids_disjoint(&result.meshes, "mapped_instances_multi_item");

    // The four IfcBuildingElementProxy occurrences.
    for occurrence in [40u32, 47, 54, 61] {
        let mut ids: Vec<Option<u32>> = result
            .meshes
            .iter()
            .filter(|m| m.express_id == occurrence)
            .map(|m| m.geometry_item_id)
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec![Some(11), Some(15)],
            "#{occurrence} must name the two IfcExtrudedAreaSolids inside map #18, \
             not its IfcMappedItem or the map itself"
        );
    }

    // Nothing may name a wrapper: #18 is the IfcRepresentationMap, #34/#41/#48/
    // #55 are the per-occurrence IfcMappedItems.
    for m in &result.meshes {
        assert!(
            !matches!(m.geometry_item_id, Some(18 | 34 | 41 | 48 | 55)),
            "mesh of #{} names wrapper entity {:?}, not a geometry item",
            m.express_id,
            m.geometry_item_id
        );
        assert_eq!(m.material_id, None, "no material layers in this file");
    }
}

/// #3199 — same pin one level deeper: a map that itself contains an
/// `IfcMappedItem` yields the INNERMOST solids, #16 (the outer map's own solid)
/// and #12 (the inner map's), not the nested item #19, the occurrence item #31,
/// or either `IfcRepresentationMap` (#14, #21).
#[test]
fn nested_mapped_item_meshes_name_the_innermost_solids() {
    let content = geometry_fixture("nested_mapped_item.ifc");
    let result = process_geometry(&content);
    assert_ids_disjoint(&result.meshes, "nested_mapped_item");

    let mut ids: Vec<Option<u32>> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == 35)
        .map(|m| m.geometry_item_id)
        .collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![Some(12), Some(16)],
        "the proxy must name the solid in each map it reaches, through the nesting"
    );

    for m in &result.meshes {
        assert!(
            !matches!(m.geometry_item_id, Some(14 | 19 | 21 | 31)),
            "mesh of #{} names a map or mapped-item wrapper {:?}",
            m.express_id,
            m.geometry_item_id
        );
        assert_eq!(m.material_id, None, "no material layers in this file");
    }
}

/// #3199 — the REST wire names, pinned.
///
/// `apps/server/src/types/mesh.rs` re-exports this very struct, so whatever
/// serde spells here is what a REST consumer reads, and
/// `packages/server-client/src/types.ts` declares those names by hand. Nothing
/// mechanical holds the two together — the TS mirror is a hand-written copy —
/// so this test pins the half that a Rust-side rename would silently move.
///
/// It also pins the ABSENT encoding, which is the part a `field?: number`
/// mirror gets wrong most easily: both fields carry
/// `skip_serializing_if = "Option::is_none"`, so `None` is a MISSING KEY and
/// never `null`. A TS optional means absent, not nullable, so the two agree
/// only while that attribute stays on. Drop it and the mirror becomes wrong
/// without a single line of TS changing.
#[test]
fn the_two_id_fields_serialize_under_the_names_the_rest_mirror_declares() {
    let mut mesh = MeshData::new(
        1,
        "IfcWall".to_string(),
        vec![0.0; 9],
        vec![0.0; 9],
        vec![0, 1, 2],
        [1.0, 1.0, 1.0, 1.0],
    );

    // Rep-item side: the name is present, the material name is not.
    mesh = mesh.with_style_metadata(None, Some(42), false);
    let v = serde_json::to_value(&mesh).expect("MeshData serializes");
    assert_eq!(
        v.get("geometry_item_id").and_then(|x| x.as_u64()),
        Some(42),
        "the REST mirror declares `geometry_item_id`"
    );
    assert!(
        v.get("material_id").is_none(),
        "an absent material layer must be a MISSING KEY, not null — \
         `material_id?: number` in the TS mirror means absent, and a \
         `null` would type-error there: got {:?}",
        v.get("material_id")
    );

    // Material side: the same two names, the other way round.
    let mesh = mesh.with_style_metadata(None, Some(7), true);
    let v = serde_json::to_value(&mesh).expect("MeshData serializes");
    assert_eq!(
        v.get("material_id").and_then(|x| x.as_u64()),
        Some(7),
        "the REST mirror declares `material_id`"
    );
    assert!(
        v.get("geometry_item_id").is_none(),
        "the setter must CLEAR the other field, or the wire carries both and \
         the disjointness the mirror documents is false over REST: got {:?}",
        v.get("geometry_item_id")
    );
}


/// #3199 follow-up — an AIR GAP layer must not be reported as `IfcMaterial #0`.
///
/// The middle layer omits its `Material`, so the slicer receives `material_id
/// == 0` for it. Before the `source_id.filter(|&id| id != 0)` in
/// `with_style_metadata`, that slab came back carrying `material_id: Some(0)`.
/// The disjointness was airtight and the navigability was not: `#0` is not an
/// entity, and following it is the one thing this field exists for.
///
/// This is the pre-#3199 defect one field over — an id that a host cannot
/// follow, with nothing in the payload to say so — so it is pinned here rather
/// than left to the reviewer who noticed it.
#[test]
fn an_air_gap_layer_reports_no_material_rather_than_material_zero() {
    let (meshes, sliceable) = produce_wall(&three_layer_wall_with_air_gap("#40"));
    assert!(
        sliceable,
        "the fixture must still slice, or this test proves nothing about the slice path"
    );
    assert_ids_disjoint(&meshes, "air_gap_wall");

    // Non-vacuity FIRST: the real materials must still come through, otherwise
    // "no mesh carries 0" is satisfied by no mesh carrying anything.
    let materials: Vec<u32> = meshes.iter().filter_map(|m| m.material_id).collect();
    assert!(
        materials.contains(&200),
        "the two Finish layers still name IfcMaterial #200: got {materials:?}"
    );
    assert!(
        !materials.contains(&201),
        "#201 is no longer referenced by any layer in this fixture: got {materials:?}"
    );

    // The air-gap slab itself: present as geometry, absent as a material.
    assert!(
        !materials.contains(&0),
        "an air gap reported `IfcMaterial #0`, which is not an entity: got {materials:?}"
    );
    for m in &meshes {
        assert_ne!(
            m.material_id,
            Some(0),
            "mesh of #{} carries material_id 0",
            m.express_id
        );
        assert_ne!(
            m.geometry_item_id,
            Some(0),
            "mesh of #{} carries geometry_item_id 0 — 0 is not a STEP instance name",
            m.express_id
        );
    }

    // And the gap did produce a slab: three layers in, three slabs out. If the
    // filter had instead DROPPED the mesh, this count would fall to 2 and the
    // assertions above would pass for the wrong reason.
    let slabs = meshes.len();
    assert_eq!(
        slabs, 3,
        "the air-gap layer must still be MESHED, only unattributed — got {slabs} slabs"
    );
}
