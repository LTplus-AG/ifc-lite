// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Test that IFC files with materials/colors/styling entities don't crash
// the geometry processing pipeline.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{calculate_normals, GeometryRouter};

const IFC_WITH_MATERIALS: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Created by ifc-lite'),'2;1');
FILE_NAME('created.ifc','20260304T144645',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPERSON($,$,'',$,$,$,$,$);
#2=IFCORGANIZATION($,'ifc-lite',$,$,$);
#3=IFCPERSONANDORGANIZATION(#1,#2,$);
#4=IFCAPPLICATION(#2,'1.0','ifc-lite','ifc-lite');
#5=IFCOWNERHISTORY(#3,#4,$,.NOCHANGE.,$,$,$,1772635605);
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCDIRECTION((1.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);
#10=IFCLOCALPLACEMENT($,#9);
#11=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#9,$);
#12=IFCGEOMETRICREPRESENTATIONSUBCONTEXT($,'Body',*,*,*,*,#11,$,.MODEL_VIEW.,$);
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT($,'Axis',*,*,*,*,#11,$,.GRAPH_VIEW.,$);
#14=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);
#15=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#16=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#17=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);
#18=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#19=IFCUNITASSIGNMENT((#15,#16,#17,#18));
#20=IFCCOLOURRGB($,0.75,0.73,0.68);
#21=IFCSURFACESTYLERENDERING(#20,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);
#22=IFCSURFACESTYLE('Default',.BOTH.,(#21));
#23=IFCPROJECT('gdyqF34SL_f6OH3t5CaYo1',#5,'Materials Test',$,$,$,$,(#11),#19);
#24=IFCSITE('Hyu20u24$IlfxD_5cWoW5g',#5,'Site',$,$,#10,$,$,.ELEMENT.,$,$,$,$,$);
#25=IFCBUILDING('4juk6yTjH6M9dUZv6zSDvn',#5,'Building',$,$,#10,$,$,.ELEMENT.,$,$,$);
#27=IFCCARTESIANPOINT((0.,0.,0.));
#28=IFCAXIS2PLACEMENT3D(#27,$,$);
#29=IFCLOCALPLACEMENT(#10,#28);
#26=IFCBUILDINGSTOREY('ggB5grjDtkd4D1j1jtHVWX',#5,'Ground Floor',$,$,$,#29,$,.ELEMENT.,0.);
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCDIRECTION((1.,0.,0.));
#32=IFCAXIS2PLACEMENT3D(#30,$,#31);
#33=IFCLOCALPLACEMENT(#29,#32);
#34=IFCCARTESIANPOINT((2.5,0.));
#35=IFCAXIS2PLACEMENT2D(#34,$);
#36=IFCRECTANGLEPROFILEDEF(.AREA.,$,#35,5.,0.2);
#37=IFCCARTESIANPOINT((0.,0.,0.));
#38=IFCAXIS2PLACEMENT3D(#37,$,$);
#39=IFCEXTRUDEDAREASOLID(#36,#38,#7,3.);
#40=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#39));
#41=IFCPRODUCTDEFINITIONSHAPE($,$,(#40));
#42=IFCWALL('4lERije6IRh2Jj3ATgaBCv',#5,'Colored Wall',$,$,#33,#41,$,.STANDARD.);
#43=IFCMATERIAL('Plaster',$,'Finish');
#44=IFCMATERIALLAYER(#43,0.015,.F.,'Plaster',$,'Finish',$);
#45=IFCMATERIAL('Brick',$,'Structural');
#46=IFCMATERIALLAYER(#45,0.2,.F.,'Brick',$,'Structural',$);
#47=IFCMATERIALLAYER(#43,0.015,.F.,'Plaster',$,'Finish',$);
#48=IFCMATERIALLAYERSET((#44,#46,#47),'Wall Assembly',$);
#49=IFCCARTESIANPOINT((2.5,3.,0.));
#50=IFCAXIS2PLACEMENT3D(#49,$,$);
#51=IFCLOCALPLACEMENT(#29,#50);
#52=IFCCARTESIANPOINT((0.,0.));
#53=IFCAXIS2PLACEMENT2D(#52,$);
#54=IFCRECTANGLEPROFILEDEF(.AREA.,$,#53,0.4,0.4);
#55=IFCCARTESIANPOINT((0.,0.,0.));
#56=IFCAXIS2PLACEMENT3D(#55,$,$);
#57=IFCEXTRUDEDAREASOLID(#54,#56,#7,3.);
#58=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#57));
#59=IFCPRODUCTDEFINITIONSHAPE($,$,(#58));
#60=IFCCOLUMN('a1lK$IrkVJuVh7VZtvUqpQ',#5,'Concrete Column',$,$,#51,#59,$,.COLUMN.);
#61=IFCMATERIAL('Concrete C30/37',$,'Concrete');
#62=IFCCARTESIANPOINT((0.,0.,-0.3));
#63=IFCAXIS2PLACEMENT3D(#62,$,$);
#64=IFCLOCALPLACEMENT(#29,#63);
#65=IFCCARTESIANPOINT((3.,2.5));
#66=IFCAXIS2PLACEMENT2D(#65,$);
#67=IFCRECTANGLEPROFILEDEF(.AREA.,$,#66,6.,5.);
#68=IFCCARTESIANPOINT((0.,0.,0.));
#69=IFCAXIS2PLACEMENT3D(#68,$,$);
#70=IFCEXTRUDEDAREASOLID(#67,#69,#7,0.3);
#71=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#70));
#72=IFCPRODUCTDEFINITIONSHAPE($,$,(#71));
#73=IFCSLAB('GGseFp0DVUmFFCbFJlz1Nt',#5,'Floor Slab',$,$,#64,#72,$,.FLOOR.);
#74=IFCCARTESIANPOINT((0.,0.,3.));
#75=IFCDIRECTION((1.,0.,0.));
#76=IFCDIRECTION((0.,1.,0.));
#77=IFCAXIS2PLACEMENT3D(#74,#75,#76);
#78=IFCLOCALPLACEMENT(#29,#77);
#79=IFCCARTESIANPOINT((0.,0.));
#80=IFCAXIS2PLACEMENT2D(#79,$);
#81=IFCRECTANGLEPROFILEDEF(.AREA.,$,#80,0.15,0.3);
#82=IFCCARTESIANPOINT((0.,0.,0.));
#83=IFCAXIS2PLACEMENT3D(#82,$,$);
#84=IFCEXTRUDEDAREASOLID(#81,#83,#7,5.);
#85=IFCSHAPEREPRESENTATION(#12,'Body','SweptSolid',(#84));
#86=IFCPRODUCTDEFINITIONSHAPE($,$,(#85));
#87=IFCBEAM('0UQyv_lQYUi6DgkMAeLNvE',#5,'Steel Beam',$,$,#78,#86,$,.BEAM.);
#88=IFCMATERIAL('Steel S355',$,'Steel');
#89=IFCCOLOURRGB($,0.8,0.25,0.15);
#90=IFCSURFACESTYLERENDERING(#89,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);
#91=IFCSURFACESTYLE('Brick Red',.BOTH.,(#90));
#92=IFCSTYLEDITEM(#39,(#91),$);
#93=IFCCOLOURRGB($,0.6,0.6,0.6);
#94=IFCSURFACESTYLERENDERING(#93,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);
#95=IFCSURFACESTYLE('Concrete Grey',.BOTH.,(#94));
#96=IFCSTYLEDITEM(#57,(#95),$);
#97=IFCCOLOURRGB($,0.85,0.82,0.75);
#98=IFCSURFACESTYLERENDERING(#97,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);
#99=IFCSURFACESTYLE('Floor',.BOTH.,(#98));
#100=IFCSTYLEDITEM(#70,(#99),$);
#101=IFCCOLOURRGB($,0.3,0.35,0.5);
#102=IFCSURFACESTYLERENDERING(#101,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.5),IFCSPECULAREXPONENT(64.),.NOTDEFINED.);
#103=IFCSURFACESTYLE('Steel Blue',.BOTH.,(#102));
#104=IFCSTYLEDITEM(#84,(#103),$);
#105=IFCRELASSOCIATESMATERIAL('FrKR5R6rdQ2aWKFR_rT4PU',#5,$,$,(#42),#48);
#106=IFCRELASSOCIATESMATERIAL('3VK0JQNfWLsk7xqkajIWuy',#5,$,$,(#60),#61);
#107=IFCRELASSOCIATESMATERIAL('8TkQsIuYPIutj5q_ytIj$W',#5,$,$,(#87),#88);
#108=IFCRELAGGREGATES('D5HlvNsgMGn6ARBKnfkqJM',#5,$,$,#23,(#24));
#109=IFCRELAGGREGATES('Wmp4j66H4UcdRDbKeNWliO',#5,$,$,#24,(#25));
#110=IFCRELAGGREGATES('7lqiKY2uUyDxFAXDrVv7W3',#5,$,$,#25,(#26));
#111=IFCRELCONTAINEDINSPATIALSTRUCTURE('Sk6UcrRyfHg_qzK9i9tpxd',#5,$,$,(#42,#60,#73,#87),#26);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn test_ifc_with_materials_does_not_crash() {
    let content = IFC_WITH_MATERIALS;

    // Build entity index
    let entity_index = build_entity_index(content);
    assert!(!entity_index.is_empty(), "Entity index should not be empty");

    // Create decoder
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Create geometry router
    let router = GeometryRouter::with_units(content, &mut decoder);

    // Process all building elements
    let mut scanner = EntityScanner::new(content);
    let mut processed = 0;
    let mut failed = 0;

    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if !ifc_lite_core::has_geometry_by_name(type_name) {
            continue;
        }

        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            match router.process_element(&entity, &mut decoder) {
                Ok(mut mesh) => {
                    if !mesh.is_empty() {
                        // Calculate normals (same as parse_meshes does)
                        if mesh.normals.len() != mesh.positions.len() {
                            calculate_normals(&mut mesh);
                        }

                        // Verify normals match positions
                        assert_eq!(
                            mesh.normals.len(),
                            mesh.positions.len(),
                            "Normals length should match positions for entity #{} ({})",
                            id,
                            type_name
                        );

                        // Verify indices are valid
                        let vertex_count = mesh.positions.len() / 3;
                        for &idx in &mesh.indices {
                            assert!(
                                (idx as usize) < vertex_count,
                                "Index {} out of bounds for {} vertices in entity #{} ({})",
                                idx,
                                vertex_count,
                                id,
                                type_name
                            );
                        }

                        processed += 1;
                    }
                }
                Err(e) => {
                    eprintln!("Failed to process #{} ({}): {}", id, type_name, e);
                    failed += 1;
                }
            }
        }
    }

    println!("Processed {} elements, {} failed", processed, failed);
    assert!(processed > 0, "Should have processed at least one element");
}

#[test]
fn test_styled_item_parsing() {
    let content = IFC_WITH_MATERIALS;

    // Build entity index
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);

    // Decode IFCSURFACESTYLERENDERING with typed values
    let rendering = decoder
        .decode_by_id(21)
        .expect("Should decode IFCSURFACESTYLERENDERING #21");
    assert_eq!(
        rendering.ifc_type,
        ifc_lite_core::IfcType::IfcSurfaceStyleRendering
    );

    // Attribute 0: SurfaceColour (entity ref to #20)
    let color_ref = rendering.get_ref(0);
    assert_eq!(color_ref, Some(20), "SurfaceColour should reference #20");

    // Attribute 1: Transparency (float 0.0)
    let transparency = rendering.get_float(1);
    assert_eq!(transparency, Some(0.0), "Transparency should be 0.0");

    // Attribute 6: SpecularColour (typed value IFCNORMALISEDRATIOMEASURE(0.5))
    let specular = rendering.get(6);
    assert!(specular.is_some(), "SpecularColour attribute should exist");
    let specular_float = specular.unwrap().as_float();
    assert_eq!(specular_float, Some(0.5), "SpecularColour should be 0.5");

    // Attribute 7: SpecularHighlight (typed value IFCSPECULAREXPONENT(64.))
    let highlight = rendering.get(7);
    assert!(
        highlight.is_some(),
        "SpecularHighlight attribute should exist"
    );
    let highlight_float = highlight.unwrap().as_float();
    assert_eq!(
        highlight_float,
        Some(64.0),
        "SpecularHighlight should be 64.0"
    );

    // Attribute 8: ReflectanceMethod (enum NOTDEFINED)
    let method = rendering.get(8);
    assert!(method.is_some(), "ReflectanceMethod attribute should exist");

    // Decode IFCSTYLEDITEM
    let styled_item = decoder
        .decode_by_id(92)
        .expect("Should decode IFCSTYLEDITEM #92");
    assert_eq!(styled_item.ifc_type, ifc_lite_core::IfcType::IfcStyledItem);

    // Attribute 0: Item (entity ref to geometry #39)
    let item_ref = styled_item.get_ref(0);
    assert_eq!(
        item_ref,
        Some(39),
        "StyledItem should reference geometry #39"
    );

    // Decode IfcColourRgb
    let colour = decoder
        .decode_by_id(89)
        .expect("Should decode IFCCOLOURRGB #89");
    assert_eq!(colour.ifc_type, ifc_lite_core::IfcType::IfcColourRgb);

    // Attr 1: Red, Attr 2: Green, Attr 3: Blue
    let red = colour.get_float(1);
    let green = colour.get_float(2);
    let blue = colour.get_float(3);
    assert_eq!(red, Some(0.8), "Red should be 0.8");
    assert_eq!(green, Some(0.25), "Green should be 0.25");
    assert_eq!(blue, Some(0.15), "Blue should be 0.15");

    println!("All styled item parsing tests passed!");
}
