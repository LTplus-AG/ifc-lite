// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for material-layer slicing.
//!
//! Single-solid walls/slabs with `IfcMaterialLayerSetUsage` get split into
//! one sub-mesh per layer, `geometry_id` = the layer's `IfcMaterial`
//! entity ID, triangle count preserved across slicing.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::material_layer_index::{
    LayerAxis, LayerBuildup, MaterialLayerIndex,
};
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashMap;

/// Three-layer wall as a single `IfcExtrudedAreaSolid` (4 m × 0.3 m × 3 m),
/// material buildup: 50 mm finish + 200 mm core + 50 mm finish = 300 mm total.
/// Layers stack along AXIS2 (local +Y), POSITIVE, offset = −0.15 (the layer set
/// is centred on the wall's reference line, as the profile is).
fn three_layer_wall_single_solid_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#200=IFCMATERIAL('Finish',$,$);
#201=IFCMATERIAL('Core',$,$);
#210=IFCMATERIALLAYER(#200,0.05,$,'FinishOuter',$,$,$);
#211=IFCMATERIALLAYER(#201,0.2,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#200,0.05,$,'FinishInner',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'3LayerBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456790',#2,$,$,(#100),#221);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// Same wall shape but material is an `IfcMaterialConstituentSet` instead
/// of a layer set — should surface as `NotSliceable`.
fn wall_with_constituent_set_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#200=IFCMATERIAL('Concrete',$,$);
#201=IFCMATERIAL('Rebar',$,$);
#210=IFCMATERIALCONSTITUENT('ConcreteC',$,#200,$,$);
#211=IFCMATERIALCONSTITUENT('RebarC',$,#201,$,$);
#220=IFCMATERIALCONSTITUENTSET('ReinforcedConcrete',$,(#210,#211));
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456790',#2,$,$,(#100),#220);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

#[test]
fn layer_index_extracts_sliceable_buildup_from_layer_set_usage() {
    let content = three_layer_wall_single_solid_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    let buildup = index.get(100).expect("wall #100 must have buildup");
    match buildup {
        LayerBuildup::Sliceable {
            layers,
            axis,
            direction_sense,
            offset_from_reference_line,
        } => {
            assert_eq!(layers.len(), 3, "expected 3 layers");
            assert_eq!(*axis, LayerAxis::Axis2);
            assert_eq!(*direction_sense, 1.0);
            assert!((offset_from_reference_line + 0.15).abs() < 1e-9);
            assert_eq!(layers[0].material_id, 200);
            assert_eq!(layers[1].material_id, 201);
            assert_eq!(layers[2].material_id, 200);
            assert!((layers[0].thickness - 0.05).abs() < 1e-9);
            assert!((layers[1].thickness - 0.20).abs() < 1e-9);
            assert!((layers[2].thickness - 0.05).abs() < 1e-9);
        }
        LayerBuildup::NotSliceable => panic!("expected Sliceable buildup"),
    }
}

/// The streaming pre-pass builds the index from the `IfcRelAssociatesMaterial`
/// spans it already collected (`from_spans`) and ships a flat encoding to the
/// geometry workers. Both must be byte-identical to the per-worker
/// `from_content` full-file scan they replace — that is the hard gate for
/// hoisting the build out of every worker.
#[test]
fn from_spans_and_flat_roundtrip_match_from_content() {
    use ifc_lite_core::EntityScanner;

    let content = three_layer_wall_single_solid_ifc();

    // Baseline: what each worker computes today.
    let mut decoder_a = EntityDecoder::new(&content);
    let from_content = MaterialLayerIndex::from_content(&content, &mut decoder_a);

    // Pre-pass path: collect the IfcRelAssociatesMaterial spans in scan order
    // (exactly as `build_pre_pass_streaming` stashes them), then build from them.
    let mut spans: Vec<(u32, usize, usize)> = Vec::new();
    let mut scanner = EntityScanner::new(&content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELASSOCIATESMATERIAL" {
            spans.push((id, start, end));
        }
    }
    let mut decoder_b = EntityDecoder::new(&content);
    let from_spans = MaterialLayerIndex::from_spans(&spans, &mut decoder_b);
    assert_eq!(
        from_content, from_spans,
        "from_spans must equal from_content on the same file"
    );

    // Wire path: flat-encode the pre-pass index and reconstruct it worker-side.
    let flat = from_spans.to_flat();
    let injected = MaterialLayerIndex::from_flat(
        &flat.element_ids,
        &flat.axis,
        &flat.layer_counts,
        &flat.direction_sense,
        &flat.offset,
        &flat.layer_material_ids,
        &flat.layer_thicknesses,
    );
    assert_eq!(
        from_content, injected,
        "the injected (flat-decoded) index must equal from_content bit-for-bit"
    );
}

#[test]
fn layer_index_marks_constituent_set_as_not_sliceable() {
    let content = wall_with_constituent_set_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    let buildup = index.get(100).expect("wall #100 must be recorded");
    assert!(
        !buildup.is_sliceable(),
        "ConstituentSet must not be flagged sliceable"
    );
}

#[test]
fn process_element_with_material_layers_splits_wall_by_material() {
    let content = three_layer_wall_single_solid_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let buildup = index.get(100).expect("buildup").clone();
    let void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();

    let layered = router
        .process_element_with_material_layers(&wall, &mut decoder, &buildup, &void_index)
        .expect("layered path")
        .expect("Some(SubMeshCollection)");

    assert_eq!(
        layered.sub_meshes.len(),
        3,
        "expected one sub-mesh per layer"
    );
    // #3199: the ids below are IfcMaterials, and the collection has to SAY so —
    // it is the only thing that tells a caller whether `geometry_id` is a
    // material or a representation item.
    assert!(
        layered.ids_are_materials,
        "the slicer's collection must declare its ids are material layers"
    );
    // Two outer finishes share material #200, core is #201.
    let ids: Vec<u32> = layered.sub_meshes.iter().map(|s| s.geometry_id).collect();
    assert_eq!(ids, vec![200, 201, 200]);
    for sub in &layered.sub_meshes {
        assert!(
            !sub.mesh.is_empty(),
            "layer (material {}) should not be empty",
            sub.geometry_id
        );
    }
}

/// Regression for #874: slicing fires only when the router's `MaterialLayerIndex`
/// is set. The slicing kernel stayed intact, but #874 dropped the
/// `set_material_layer_index` wiring from every pipeline, so the DEFAULT
/// sub-mesh path (`process_element_with_submeshes`, which `produce_element_meshes`
/// runs) silently stopped slicing — layered walls rendered as a plain single
/// solid. With the index attached (as every pipeline does again) the same path
/// slices; without it, the wall stays one solid.
#[test]
fn router_layer_index_drives_submesh_slicing() {
    let content = three_layer_wall_single_solid_ifc();

    // No index attached — the #874-broken behaviour: one solid, no slices.
    let without = {
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);
        let wall = decoder.decode_by_id(100).expect("decode wall");
        router
            .process_element_with_submeshes(&wall, &mut decoder)
            .expect("submesh path")
            .sub_meshes
            .len()
    };
    assert_eq!(without, 1, "without a layer index the wall must stay a single solid");

    // Index attached — what `set_material_layer_index` now does in production.
    let with = {
        let mut decoder = EntityDecoder::new(&content);
        let mut router = GeometryRouter::with_units(&content, &mut decoder);
        let index = MaterialLayerIndex::from_content(&content, &mut decoder);
        router.set_material_layer_index(std::sync::Arc::new(index));
        let wall = decoder.decode_by_id(100).expect("decode wall");
        router
            .process_element_with_submeshes(&wall, &mut decoder)
            .expect("submesh path")
            .sub_meshes
            .len()
    };
    assert_eq!(with, 3, "router with a layer index must slice into one sub-mesh per layer");
}

fn three_layer_wall_with_opening_ifc() -> String {
    // Same three-layer wall as above but with one IfcOpeningElement
    // (1m × 0.5m × 1.5m window) cutting the full thickness via
    // IfcRelVoidsElement. Verifies voids-then-slice composes correctly.
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((1.5,-0.1,0.5));
#113=IFCDIRECTION((0.,0.,1.));
#114=IFCDIRECTION((1.,0.,0.));
#120=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningProfile',#121,1.0,0.5);
#121=IFCAXIS2PLACEMENT2D(#122,#123);
#122=IFCCARTESIANPOINT((0.,0.));
#123=IFCDIRECTION((1.,0.));
#130=IFCEXTRUDEDAREASOLID(#120,#131,#132,1.5);
#131=IFCAXIS2PLACEMENT3D(#133,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#133=IFCCARTESIANPOINT((0.,0.,0.));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#130));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#150=IFCOPENINGELEMENT('0001234567890123456790',#2,'TestOpening',$,$,#110,#141,$,.OPENING.);
#160=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#150);
#200=IFCMATERIAL('Finish',$,$);
#201=IFCMATERIAL('Core',$,$);
#210=IFCMATERIALLAYER(#200,0.05,$,'FinishOuter',$,$,$);
#211=IFCMATERIALLAYER(#201,0.2,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#200,0.05,$,'FinishInner',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'3LayerBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456792',#2,$,$,(#100),#221);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

#[test]
fn layers_compose_with_voids_every_layer_loses_triangles() {
    let content = three_layer_wall_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let buildup = index.get(100).expect("buildup").clone();
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(100, vec![150]);

    // Run both with and without voids to confirm the opening actually
    // removes triangles from every slab (regression guard).
    let uncut = router
        .process_element_with_material_layers(
            &wall,
            &mut decoder,
            &buildup,
            &FxHashMap::default(),
        )
        .expect("layered path uncut")
        .expect("uncut Some");
    let cut = router
        .process_element_with_material_layers(&wall, &mut decoder, &buildup, &void_index)
        .expect("layered path cut")
        .expect("cut Some");

    assert_eq!(uncut.sub_meshes.len(), 3);
    assert_eq!(cut.sub_meshes.len(), 3);

    let uncut_total: usize = uncut.sub_meshes.iter().map(|s| s.mesh.triangle_count()).sum();
    let cut_total: usize = cut.sub_meshes.iter().map(|s| s.mesh.triangle_count()).sum();
    assert!(
        cut_total != uncut_total,
        "void subtraction must change triangle count: uncut={} cut={}",
        uncut_total,
        cut_total
    );
}

/// #3199: the flag has to survive the entry the mesh producer actually calls
/// for a voided element (`process_element_with_submeshes_and_voids`), not just
/// the slicer it wraps.
///
/// WHAT THIS DOES NOT COVER, stated because an earlier version of this comment
/// claimed it did: the sub-mesh-by-sub-mesh REBUILD further down that function.
/// A layered wall returns at the `try_layered_sub_meshes` early exit and never
/// reaches it, so the `ids_are_materials` inheritance on the rebuilt collection
/// is unreachable for a material-layer collection today and no fixture can make
/// this test distinguish it — replacing that expression with a hard-coded
/// `false` leaves both `ifc-lite-geometry` and `ifc-lite-processing` green.
/// It is written as an inheritance anyway, deliberately: hard-coding would let
/// a future layered producer on that path silently relabel material ids as
/// representation items. Defensive, and honestly untested rather than
/// dishonestly claimed.
#[test]
fn voided_submesh_entry_reports_layer_ids_as_material_ids() {
    let content = three_layer_wall_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let mut router = GeometryRouter::with_units(&content, &mut decoder);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);
    router.set_material_layer_index(std::sync::Arc::new(index));

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(100, vec![150]);

    let cut = router
        .process_element_with_submeshes_and_voids(&wall, &mut decoder, &void_index)
        .expect("submesh voids path");

    assert!(
        cut.ids_are_materials,
        "a sliced layered wall must still declare material-layer ids after void subtraction"
    );
    let ids: Vec<u32> = cut.sub_meshes.iter().map(|s| s.geometry_id).collect();
    assert_eq!(ids, vec![200, 201, 200], "slabs must name their IfcMaterials");
}

#[test]
fn process_element_with_material_layers_returns_none_for_unsliceable() {
    let content = wall_with_constituent_set_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let buildup = index.get(100).expect("buildup").clone();
    let void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();

    let result = router
        .process_element_with_material_layers(&wall, &mut decoder, &buildup, &void_index)
        .expect("no error");
    assert!(
        result.is_none(),
        "ConstituentSet must produce None so caller falls back"
    );
}

// ---------------------------------------------------------------------------
// WHERE the cuts land. Everything above counts sub-meshes and reads material
// ids off them; nothing pins the geometry, and every fixture above shares three
// symmetries that make the geometry unobservable:
//
//   * length unit METRE, so `unit_scale == 1` and dropping the offset's unit
//     conversion entirely changes no number;
//   * DirectionSense POSITIVE, so `direction_sense == +1` and moving that
//     factor onto the wrong term changes no number;
//   * layer stack 50/200/50 with materials 200/201/200 — a PALINDROME, so
//     reading the stack back to front changes neither a cut position nor an
//     emitted material id.
//
// The fixture below breaks all three at once: millimetres, NEGATIVE sense, and
// three distinct thicknesses carrying three distinct materials.
// ---------------------------------------------------------------------------

/// Same 4 m × 0.30 m × 3 m wall, written in MILLIMETRES, with an asymmetric
/// 40 / 200 / 60 mm buildup of three distinct materials (#200, #201, #202).
///
/// `sense` / `offset_mm` are the layer set's `DirectionSense` and
/// `OffsetFromReferenceLine`. `.POSITIVE.` with −150 and `.NEGATIVE.` with +150
/// describe the SAME physical wall from opposite ends of the stack, so the two
/// must produce mirror-image slabs — which is what makes the sense factor
/// observable at all.
fn mm_wall_asymmetric_buildup(sense: &str, offset_mm: f64) -> String {
    mm_wall_on_axis(".AXIS2.", sense, offset_mm)
}

fn mm_wall_on_axis(layer_axis: &str, sense: &str, offset_mm: f64) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#31,4000.,300.);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3000.);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#200=IFCMATERIAL('Outer',$,$);
#201=IFCMATERIAL('Core',$,$);
#202=IFCMATERIAL('Inner',$,$);
#210=IFCMATERIALLAYER(#200,40.,$,'Outer',$,$,$);
#211=IFCMATERIALLAYER(#201,200.,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#202,60.,$,'Inner',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'3LayerBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,{layer_axis},{sense},{offset_mm:.1},$);
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456790',#2,$,$,(#100),#221);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// `(material_id, min, max)` of every emitted slab along local axis `comp`
/// (0 = X, 1 = Y, 2 = Z), in emission order.
/// The wall's local frame is the world frame here (identity placement, no RTC,
/// origin `[0,0,0]`), so `positions` ARE metres along the local axis the layers
/// stack on.
fn slab_bands(content: &str) -> Vec<(u32, f64, f64)> {
    slab_bands_on(content, 1)
}

fn slab_bands_on(content: &str, comp: usize) -> Vec<(u32, f64, f64)> {
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let index = MaterialLayerIndex::from_content(content, &mut decoder);
    let wall = decoder.decode_by_id(100).expect("decode wall");
    let buildup = index.get(100).expect("buildup").clone();
    let void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let collection = router
        .process_element_with_material_layers(&wall, &mut decoder, &buildup, &void_index)
        .expect("layered path ok")
        .expect("Some(SubMeshCollection)");
    assert_eq!(
        collection.sub_meshes[0].mesh.origin,
        [0.0, 0.0, 0.0],
        "this fixture must stay in the world frame, or the bands below are not metres of world Y"
    );
    collection
        .sub_meshes
        .iter()
        .map(|s| {
            let ys: Vec<f64> = s.mesh.positions.chunks(3).map(|p| p[comp] as f64).collect();
            let lo = ys.iter().cloned().fold(f64::INFINITY, f64::min);
            let hi = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            (s.geometry_id, lo, hi)
        })
        .collect()
}

fn assert_bands(got: &[(u32, f64, f64)], want: &[(u32, f64, f64)], what: &str) {
    assert_eq!(got.len(), want.len(), "{what}: slab count, got {got:?}");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        assert_eq!(g.0, w.0, "{what}: slab {i} material, got {got:?}");
        assert!(
            (g.1 - w.1).abs() < 1e-4 && (g.2 - w.2).abs() < 1e-4,
            "{what}: slab {i} band [{:.4},{:.4}], want [{:.4},{:.4}]",
            g.1,
            g.2,
            w.1,
            w.2
        );
    }
}

/// Each layer's slab occupies the exact band the buildup describes: the
/// thicknesses come out 40/200/60 mm in the file's own unit converted to
/// metres, in stack order, each carrying its own material.
///
/// This is the test the unit conversion is answerable to. A millimetre file
/// with the offset's `* unit_scale` dropped puts the first interface 150 METRES
/// off the wall; every earlier fixture is in metres, where that factor is 1.
#[test]
fn slabs_land_on_the_exact_bands_the_buildup_describes() {
    // POSITIVE from MlsBase at local Y = −0.15 m: outer 40 mm first, then the
    // 200 mm core, then the 60 mm inner leaf, ending at +0.15 m.
    assert_bands(
        &slab_bands(&mm_wall_asymmetric_buildup(".POSITIVE.", -150.0)),
        &[
            (200, -0.15, -0.11),
            (201, -0.11, 0.09),
            (202, 0.09, 0.15),
        ],
        "AXIS2 POSITIVE, millimetres",
    );
}

/// The mirror. NEGATIVE sense from an MlsBase at +0.15 m describes the same
/// physical wall walked from the other face, so the same stack must come out
/// reflected about Y = 0 — first layer at the TOP of the range, last at the
/// bottom.
///
/// This is what makes `direction_sense` observable. It is `+1` in every other
/// fixture in the repo, and a factor of one hides whatever it multiplies.
#[test]
fn negative_direction_sense_stacks_the_layers_the_other_way() {
    let positive = slab_bands(&mm_wall_asymmetric_buildup(".POSITIVE.", -150.0));
    let negative = slab_bands(&mm_wall_asymmetric_buildup(".NEGATIVE.", 150.0));

    assert_bands(
        &negative,
        &[
            (200, 0.11, 0.15),
            (201, -0.09, 0.11),
            (202, -0.15, -0.09),
        ],
        "AXIS2 NEGATIVE, millimetres",
    );

    // Stated as the reflection too, so the pair cannot both drift the same way.
    for (i, (p, n)) in positive.iter().zip(&negative).enumerate() {
        assert_eq!(p.0, n.0, "slab {i}: the same layer keeps its material");
        assert!(
            (p.1 + n.2).abs() < 1e-4 && (p.2 + n.1).abs() < 1e-4,
            "slab {i}: NEGATIVE must mirror POSITIVE about Y=0, got {p:?} vs {n:?}"
        );
    }
}

/// `LayerSetDirection` selects which LOCAL AXIS the stack runs along, and the
/// AXIS1/AXIS3 arms of `LayerAxis::unit_vector` are reached by no other test in
/// the repo — every fixture is an AXIS2 wall, so both could return the +Y unit
/// vector and nothing would notice.
///
/// AXIS3 on the same body stacks through the extrusion depth (local +Z), which
/// is how slabs, roofs and coverings are described. It also pins the
/// layer-set-shorter-than-the-body rule: this buildup is 300 mm on a 3 m
/// extrusion, and the LAST slab keeps the whole remainder rather than the
/// geometry above the final interface being dropped.
#[test]
fn axis3_stacks_the_layers_through_the_extrusion_depth() {
    assert_bands(
        &slab_bands_on(&mm_wall_on_axis(".AXIS3.", ".POSITIVE.", 0.0), 2),
        &[
            (200, 0.0, 0.04),
            (201, 0.04, 0.24),
            (202, 0.24, 3.0),
        ],
        "AXIS3 POSITIVE, millimetres",
    );
}
