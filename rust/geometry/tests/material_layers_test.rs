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
/// Layers stack along AXIS2 (local +Y), POSITIVE, offset = 0.
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

/// Asymmetric buildup: three DISTINCT materials, three DISTINCT thicknesses,
/// and a reference-line offset that is NOT half the total.
///
/// Every other fixture in this file uses `[0.05, 0.20, 0.05]` of materials
/// `[200, 201, 200]` at `offset = -0.15` on a `0.30`-thick centred profile —
/// a palindrome in both thickness and material, centred on the reference line.
/// Under it, reversing the layer stack leaves the cumulative interface
/// distances (0.05, 0.25) and the asserted id vector unchanged, and replacing
/// the authored `offset_from_reference_line` with a hard-coded `-total/2` is
/// numerically the identity. Both mutations were confirmed to survive every
/// other test in this file (7 passed, 0 failed under each), and the reversal
/// also survives `material_layers_local_frame_test`.
///
/// Here the layers are 50 / 250 / 100 mm (total 400 mm) on a profile shifted
/// +50 mm in local Y, so the wall body spans y in [-0.15, 0.25] and the usage
/// offset is -0.15 != -0.20. Reversing the stack moves the interfaces to
/// (0.10, 0.35); centring it moves them to (-0.15, 0.10). Both are visible in
/// the slab bands asserted below.
fn asymmetric_three_layer_wall_ifc() -> String {
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
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#31,4.0,0.4);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.05));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#51,'Test',$);
#200=IFCMATERIAL('Cladding',$,$);
#201=IFCMATERIAL('Core',$,$);
#202=IFCMATERIAL('Lining',$,$);
#210=IFCMATERIALLAYER(#200,0.05,$,'Cladding',$,$,$);
#211=IFCMATERIALLAYER(#201,0.25,$,'Core',$,$,$);
#212=IFCMATERIALLAYER(#202,0.10,$,'Lining',$,$,$);
#220=IFCMATERIALLAYERSET((#210,#211,#212),'AsymBuildup',$);
#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);
#300=IFCRELASSOCIATESMATERIAL('0001234567890123456790',#2,$,$,(#100),#221);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

/// World-space Y extent of a sub-mesh (`world = origin + position`).
fn y_band(sub: &ifc_lite_geometry::mesh::SubMesh) -> (f64, f64) {
    let o = sub.mesh.origin[1];
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for v in sub.mesh.positions.chunks_exact(3) {
        let y = v[1] as f64 + o;
        lo = lo.min(y);
        hi = hi.max(y);
    }
    (lo, hi)
}

#[test]
fn layer_slabs_land_where_the_authored_thicknesses_and_offset_put_them() {
    let content = asymmetric_three_layer_wall_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    // The buildup must reach the router with its authored asymmetry intact.
    match index.get(100).expect("wall #100 buildup") {
        LayerBuildup::Sliceable {
            layers,
            axis,
            direction_sense,
            offset_from_reference_line,
        } => {
            assert_eq!(*axis, LayerAxis::Axis2);
            assert_eq!(*direction_sense, 1.0);
            assert!((offset_from_reference_line + 0.15).abs() < 1e-9);
            let t: Vec<f64> = layers.iter().map(|l| l.thickness).collect();
            let m: Vec<u32> = layers.iter().map(|l| l.material_id).collect();
            assert_eq!(m, vec![200, 201, 202], "materials must stay in stack order");
            for (got, want) in t.iter().zip([0.05, 0.25, 0.10]) {
                assert!((got - want).abs() < 1e-9, "thicknesses {t:?}");
            }
            // The offset is NOT half the total — a hard-coded "centre the
            // stack" cannot masquerade as the authored value here.
            let total: f64 = t.iter().sum();
            assert!(
                (offset_from_reference_line + total / 2.0).abs() > 1e-3,
                "fixture must not centre the stack on the reference line"
            );
        }
        LayerBuildup::NotSliceable => panic!("expected Sliceable buildup"),
    }

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let buildup = index.get(100).expect("buildup").clone();
    let layered = router
        .process_element_with_material_layers(
            &wall,
            &mut decoder,
            &buildup,
            &FxHashMap::default(),
        )
        .expect("layered path")
        .expect("Some(SubMeshCollection)");

    assert_eq!(layered.sub_meshes.len(), 3, "one sub-mesh per layer");
    let ids: Vec<u32> = layered.sub_meshes.iter().map(|s| s.geometry_id).collect();
    assert_eq!(ids, vec![200, 201, 202], "slabs come out in stack order");

    // Each slab occupies exactly its authored band along the layer axis.
    // Interfaces at offset + cumulative = -0.15 + 0.05 = -0.10 and
    // -0.15 + 0.30 = +0.15; the outer faces are the wall body's own
    // y in [-0.15, +0.25].
    let expected = [(-0.15, -0.10), (-0.10, 0.15), (0.15, 0.25)];
    for (sub, (want_lo, want_hi)) in layered.sub_meshes.iter().zip(expected) {
        let (lo, hi) = y_band(sub);
        assert!(
            (lo - want_lo).abs() < 1e-4 && (hi - want_hi).abs() < 1e-4,
            "material {} slab band: expected [{want_lo}, {want_hi}], got [{lo}, {hi}]",
            sub.geometry_id
        );
    }
}

/// The same asymmetric wall with `DirectionSense = .NEGATIVE.`, the stack
/// anchored at the far face (`offset = +0.25`) and growing back along -Y.
///
/// Every `IfcMaterialLayerSetUsage` fixture in the repository is
/// `.AXIS2., .POSITIVE.`, so `direction_sense` was `1.0` everywhere — a
/// multiplier of one. `build_layer_planes` multiplies by it twice (the plane
/// normal and the interface distance) and `resolve_layer_set_usage` has a
/// `NEGATIVE => -1.0` arm; none of it was reachable from a test.
fn asymmetric_three_layer_wall_negative_sense_ifc() -> String {
    asymmetric_three_layer_wall_ifc().replace(
        "#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.POSITIVE.,-0.15,$);",
        "#221=IFCMATERIALLAYERSETUSAGE(#220,.AXIS2.,.NEGATIVE.,0.25,$);",
    )
}

#[test]
fn a_negative_direction_sense_stacks_the_layers_the_other_way() {
    let content = asymmetric_three_layer_wall_negative_sense_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let index = MaterialLayerIndex::from_content(&content, &mut decoder);

    match index.get(100).expect("wall #100 buildup") {
        LayerBuildup::Sliceable {
            direction_sense,
            offset_from_reference_line,
            ..
        } => {
            assert_eq!(*direction_sense, -1.0, "NEGATIVE must resolve to -1.0");
            assert!((offset_from_reference_line - 0.25).abs() < 1e-9);
        }
        LayerBuildup::NotSliceable => panic!("expected Sliceable buildup"),
    }

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let buildup = index.get(100).expect("buildup").clone();
    let layered = router
        .process_element_with_material_layers(
            &wall,
            &mut decoder,
            &buildup,
            &FxHashMap::default(),
        )
        .expect("layered path")
        .expect("Some(SubMeshCollection)");

    assert_eq!(layered.sub_meshes.len(), 3, "one sub-mesh per layer");
    let ids: Vec<u32> = layered.sub_meshes.iter().map(|s| s.geometry_id).collect();
    assert_eq!(ids, vec![200, 201, 202], "slabs still come out in stack order");

    // Interfaces at offset + sense*cumulative = 0.25 - 0.05 = +0.20 and
    // 0.25 - 0.30 = -0.05. The first (50 mm) layer is now the one against the
    // +Y face, the mirror image of the POSITIVE case above.
    let expected = [(0.20, 0.25), (-0.05, 0.20), (-0.15, -0.05)];
    for (sub, (want_lo, want_hi)) in layered.sub_meshes.iter().zip(expected) {
        let (lo, hi) = y_band(sub);
        assert!(
            (lo - want_lo).abs() < 1e-4 && (hi - want_hi).abs() < 1e-4,
            "material {} slab band: expected [{want_lo}, {want_hi}], got [{lo}, {hi}]",
            sub.geometry_id
        );
    }
}
