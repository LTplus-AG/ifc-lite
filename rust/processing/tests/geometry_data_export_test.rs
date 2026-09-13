// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Verifies the analysis geometry-data export: welded, IFC Z-up, absolute-world
//! metres, occurrences only. Uses an INLINE minimal IFC (a unit cube at the
//! origin) so the test runs in CI without any external fixture.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex};
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions, GEOM_CLASS_LAYER_SLICE,
};
use ifc_lite_processing::{build_geometry_data_export, process_geometry, MeshData};
use rustc_hash::FxHashMap;
use std::sync::Arc;

/// Minimal IFC4: one IfcBuildingElementProxy, a unit cube extruded over
/// [0,0,0]..[1,1,1], identity placement, metre units.
const CUBE_IFC: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-06,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('11tEAnIV5BixApwp1YzpwS',$,'t',$,$,$,$,(#5),#2);
#8=IFCCARTESIANPOINT((0.,0.));
#9=IFCCARTESIANPOINT((1.,0.));
#10=IFCCARTESIANPOINT((1.,1.));
#11=IFCCARTESIANPOINT((0.,1.));
#12=IFCPOLYLINE((#8,#9,#10,#11,#8));
#13=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#12);
#14=IFCCARTESIANPOINT((0.,0.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));
#17=IFCEXTRUDEDAREASOLID(#13,#15,#16,1.);
#18=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#17));
#19=IFCPRODUCTDEFINITIONSHAPE($,$,(#18));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCLOCALPLACEMENT($,#21);
#23=IFCBUILDINGELEMENTPROXY('36FTsOKg956eWgO6DwnT8U',$,'cube',$,$,#22,#19,$,$);
ENDSEC;
END-ISO-10303-21;
"##;

fn bbox(v: &[[f64; 3]]) -> ([f64; 3], [f64; 3]) {
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for p in v {
        for i in 0..3 {
            mn[i] = mn[i].min(p[i]);
            mx[i] = mx[i].max(p[i]);
        }
    }
    (mn, mx)
}

fn approx(got: [f64; 3], want: [f64; 3], what: &str) {
    for i in 0..3 {
        assert!(
            (got[i] - want[i]).abs() < 1e-4,
            "{what}: axis {i} got {} want {}",
            got[i],
            want[i]
        );
    }
}

#[test]
fn geometry_data_export_is_welded_zup_world() {
    let result = process_geometry(CUBE_IFC);
    let rtc = result.metadata.coordinate_info.origin_shift;
    // No site-local rotation for this identity-placement model.
    let export = build_geometry_data_export(&result.meshes, rtc, None);

    assert_eq!(export.schema, "ifc-lite-geometry-data");
    assert_eq!(export.up_axis, "Z");
    assert_eq!(export.units, "m");
    assert_eq!(export.element_count, 1, "expected the single cube occurrence");

    let cube = export.elements.values().next().expect("cube present");
    assert_eq!(cube.ifc_type, "IfcBuildingElementProxy");
    // Position-welded: a box collapses to its 8 corners / 12 triangles (not the
    // ~24 normal-split or ~36 unwelded verts).
    assert_eq!(
        cube.vertices.len(),
        8,
        "cube should weld to 8 corners, got {}",
        cube.vertices.len()
    );
    assert_eq!(cube.faces.len(), 12, "cube = 12 triangles, got {}", cube.faces.len());

    // Absolute world, IFC Z-up: [0,0,0]..[1,1,1].
    let (mn, mx) = bbox(&cube.vertices);
    approx(mn, [0.0, 0.0, 0.0], "cube min");
    approx(mx, [1.0, 1.0, 1.0], "cube max");

    // Faces index in range, non-degenerate.
    let n = cube.vertices.len() as u32;
    for f in &cube.faces {
        assert!(f[0] < n && f[1] < n && f[2] < n, "face index out of range");
        assert!(f[0] != f[1] && f[1] != f[2] && f[0] != f[2], "degenerate face");
    }

    // JSON contract round-trips.
    let json = export.to_json().expect("serialize");
    assert!(json.contains("ifc-lite-geometry-data"));
}

/// A three-layer wall (50 mm / 200 mm / 50 mm, one swept-solid body item) that
/// the material-layer index calls sliceable, so its body comes out as class-3
/// layer slices and no class-0 mesh.
const LAYERED_WALL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('geometry-data export layered wall'),'2;1');
FILE_NAME('wall.ifc','2026-09-13T00:00:00',(''),(''),'','','');
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
#100=IFCWALL('0001234567890123456789',$,'LayeredWall',$,$,#20,#51,'Test',$);
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
"#;

/// Mesh wall #100 through the canonical producer with the material-layer index
/// armed, as the wasm batch path and the appearance context do.
fn produce_layered_wall() -> Vec<MeshData> {
    let mut decoder = EntityDecoder::new(LAYERED_WALL_IFC);
    let mut router = GeometryRouter::with_units(LAYERED_WALL_IFC, &mut decoder);
    let index = MaterialLayerIndex::from_content(LAYERED_WALL_IFC, &mut decoder);
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
    let options = MeshProductionOptions::default();
    produce_element_meshes(&job, &ctx, &options, &mut decoder, &router).meshes
}

/// The export filtered on `geometry_class != 0`, which also caught class 3
/// (`GEOM_CLASS_LAYER_SLICE`): a material-layer wall's slices are its body, not
/// type-product geometry, so the wall vanished from the export (#4663).
#[test]
fn geometry_data_export_keeps_a_material_layer_wall() {
    let meshes = produce_layered_wall();
    assert!(
        meshes.len() == 3 && meshes.iter().all(|m| m.geometry_class == GEOM_CLASS_LAYER_SLICE),
        "fixture premise: the wall meshes as three class-3 layer slices, got classes {:?}",
        meshes.iter().map(|m| m.geometry_class).collect::<Vec<_>>()
    );

    let export = build_geometry_data_export(&meshes, [0.0; 3], None);
    let wall = export.elements.get(&100).expect("layered wall #100 must be exported");
    let (mn, mx) = bbox(&wall.vertices);
    approx(mn, [-2.0, -0.15, 0.0], "layered wall min");
    approx(mx, [2.0, 0.15, 3.0], "layered wall max");
}
