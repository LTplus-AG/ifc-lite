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
