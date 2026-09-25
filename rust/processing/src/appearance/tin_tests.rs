// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! #5942: the appearance planner textures a terrain TIN
//! (`IfcTriangulatedIrregularNetwork`), which the LandXML → IFC4X3 export
//! uses to carry draped imagery (mapping spec §15.5) instead of writing a
//! second texture writer.
use super::*;

/// The shape `landXmlToIfc` writes for one terrain surface, at survey-scale
/// LV95 coordinates: a 100 m × 50 m TIN whose corners are the image's.
const TERRAIN_IFC4X3: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-5942 terrain imagery'),'2;1');
FILE_NAME('terrain.ifc','2026-09-25T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOGRAPHICELEMENT('1TerrainTin00000000000',$,'Existing Ground',$,$,#11,#12,$,.TERRAIN.);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDIRREGULARNETWORK(#15,$,.F.,((1,2,3),(1,3,4)),$,(0));
#15=IFCCARTESIANPOINTLIST3D(((2600000.,1200000.,400.),(2600100.,1200000.,401.),(2600100.,1200050.,402.),(2600000.,1200050.,401.)));
ENDSEC;
END-ISO-10303-21;
"#;

fn orthophoto_request() -> AppearanceRequest {
    AppearanceRequest {
        representation_policy: RepresentationPolicy::Preserve,
        schema: "IFC4X3".into(),
        source_revision: "landxml-export".into(),
        next_express_id: 100,
        product_ids: vec![10],
        image_uri: "ortho.png".into(),
        repeat_s: false,
        repeat_t: false,
        // The drape's planar projection (§15.3): bottom-left corner, east and
        // north axes, the image's 100 m × 50 m extent.
        mapping: Mapping::Planar {
            frame: MappingFrame::World,
            origin: [2_600_000., 1_200_000., 0.],
            axis_u: [1., 0., 0.],
            axis_v: [0., 1., 0.],
            metres_per_tile: [100., 50.],
        },
        face_masks: Vec::new(),
    }
}

#[test]
fn issue_5942_planar_world_mapping_textures_a_terrain_tin() {
    let plan = plan_appearance(TERRAIN_IFC4X3.as_bytes(), &orthophoto_request()).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    assert_eq!(plan.items.len(), 1);
    let item = &plan.items[0];
    assert_eq!(item.geometry_item_id, 14, "the TIN itself is the mapped item");
    // The image's corners are the TIN's: UV 0 and 1, bottom-left origin.
    assert_eq!(item.tex_coords, vec![[0., 0.], [1., 0.], [1., 1.], [0., 1.]]);
    assert_eq!(item.tex_coord_index, vec![[1, 2, 3], [1, 3, 4]]);
    let created = |kind: &str| plan.created.iter().find(|entity| entity.r#type == kind).unwrap_or_else(|| panic!("no {kind}"));
    let image = created("IfcImageTexture");
    assert_eq!(image.attributes[0], json!(".F."));
    assert_eq!(image.attributes[1], json!(".F."));
    assert_eq!(image.attributes[5], json!("ortho.png"));
    assert_eq!(created("IfcIndexedTriangleTextureMap").attributes[1], json!("#14"));
    assert_eq!(created("IfcStyledItem").attributes[0], json!("#14"));
    assert!(plan.created.iter().any(|entity| entity.r#type == "IfcSurfaceStyleWithTextures"));
    assert!(plan.edits.is_empty() && plan.removed.is_empty(), "an unstyled TIN gains a style; nothing is rewritten");
}

#[test]
fn issue_5942_textured_tin_reopens_with_its_image_reference_and_uvs() {
    let plan = plan_appearance(TERRAIN_IFC4X3.as_bytes(), &orthophoto_request()).unwrap();
    let output = super::tests::apply(TERRAIN_IFC4X3, &plan);
    let reopened = crate::process_geometry(output.as_bytes());
    let mesh = reopened.meshes.iter().find(|mesh| mesh.express_id == 10).expect("terrain mesh");
    let texture = mesh.texture.as_ref().expect("the TIN reopens textured");
    assert_eq!(texture.url.as_deref(), Some("ortho.png"));
    assert!(!texture.repeat_s && !texture.repeat_t);
    let uvs = mesh.uvs.as_ref().expect("uvs");
    assert_eq!(uvs.len(), mesh.positions.len() / 3 * 2);
    // Every UV of this TIN is an image corner.
    assert!(uvs.iter().all(|value| (value.abs() < 1e-6) || ((value - 1.).abs() < 1e-6)), "{uvs:?}");
}
