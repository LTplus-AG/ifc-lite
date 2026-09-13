// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_processing::process_geometry;

const FILL: &str = "ISO-10303-21;HEADER;FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');FILE_NAME('fill.ifc','2026-09-10T00:00:00',(''),(''),'IfcOpenShell','IfcOpenShell','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);#5=IFCUNITASSIGNMENT((#4));#6=IFCPROJECT('0000000000000000000000',$,'Annotation fill controls',$,$,$,$,(#3),#5);
#10=IFCCARTESIANPOINT((0.,0.));#11=IFCCARTESIANPOINT((4000.,0.));#12=IFCCARTESIANPOINT((4000.,4000.));#13=IFCCARTESIANPOINT((0.,4000.));
#14=IFCCARTESIANPOINT((1000.,1000.));#15=IFCCARTESIANPOINT((2000.,1000.));#16=IFCCARTESIANPOINT((2000.,2000.));#17=IFCCARTESIANPOINT((1000.,2000.));
#20=IFCPOLYLINE((#10,#11,#12,#13,#10));#21=IFCPOLYLINE((#14,#15,#16,#17,#14));#22=IFCANNOTATIONFILLAREA(#20,(#21));
#23=IFCCOLOURRGB($,0.2,0.6,0.8);#24=IFCFILLAREASTYLE('Cyan fill',(#23),.F.);#25=IFCSTYLEDITEM(#22,(#24),$);
#30=IFCSHAPEREPRESENTATION(#3,'Annotation','Annotation2D',(#22));#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));#32=IFCLOCALPLACEMENT($,#2);
#40=IFCANNOTATION('0000000000000000000001',$,'Horizontal fill',$,$,#32,#31);
#41=IFCDIRECTION((0.,1.,0.));#42=IFCCARTESIANPOINT((10000.,20000.,30000.));#43=IFCAXIS2PLACEMENT3D(#42,#41,$);#44=IFCLOCALPLACEMENT($,#43);
#45=IFCANNOTATION('0000000000000000000002',$,'Vertical fill',$,$,#44,#31);
#50=IFCSHAPEREPRESENTATION(#3,'FootPrint','Annotation2D',(#22));#51=IFCREPRESENTATIONMAP(#2,#50);#52=IFCDOORTYPE('0000000000000000000003',$,'Footprint only',$,$,$,(#51),$,$,.DOOR.,.SINGLE_SWING_LEFT.,.F.,$);
ENDSEC;END-ISO-10303-21;";

#[test]
fn annotation_4406_native_fill_styles_holes_units_and_type_scope() {
    let result = process_geometry(&FILL.as_bytes());
    assert_eq!(result.meshes.len(), 2, "{:?}", result.stats);
    for mesh in &result.meshes {
        assert_eq!(mesh.ifc_type, "IfcAnnotation");
        assert_eq!(mesh.geometry_item_id, Some(22));
        assert_eq!(mesh.material_name.as_deref(), Some("Cyan fill"));
        for (actual, expected) in mesh.color.iter().zip([0.2, 0.6, 0.8, 1.]) {
            assert!((actual - expected).abs() < 1e-6);
        }
        assert_eq!(mesh.indices.len(), 24);
        let mut area = 0f64;
        for tri in mesh.indices.chunks_exact(3) {
            let p: Vec<_> = tri
                .iter()
                .map(|i| {
                    let i = *i as usize * 3;
                    nalgebra::Vector3::new(
                        mesh.positions[i] as f64,
                        mesh.positions[i + 1] as f64,
                        mesh.positions[i + 2] as f64,
                    )
                })
                .collect();
            area += (p[1] - p[0]).cross(&(p[2] - p[0])).norm() * 0.5;
        }
        assert!((area - 15.).abs() < 1e-6, "{area}");
    }
}

#[test]
fn annotation_4406_ifc2x3_style_assignment_wrapper() {
    let source = FILL
        .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))")
        .replace("(#23),.F.)", "(#23))")
        .replace(
            "#25=IFCSTYLEDITEM(#22,(#24),$);",
            "#26=IFCPRESENTATIONSTYLEASSIGNMENT((#24));#25=IFCSTYLEDITEM(#22,(#26),$);",
        );
    let result = process_geometry(&source.as_bytes());
    assert_eq!(result.meshes.len(), 2);
    assert!(result
        .meshes
        .iter()
        .all(|m| m.material_name.as_deref() == Some("Cyan fill")));
}

/// The pre-pass style index (`style::fill::fill_style_from_styled_item`, via
/// the public `prepass::resolve_styled_item_spans`) reads an
/// `IfcStyledItem.Styles` list by the same rule as the 2D symbolic index
/// (`symbolic::color`): a reference that does not resolve is skipped, and a
/// bare reference is a one-element list. The pre-pass reader used `?` inside
/// its loops, so one dangling entry left the fill item with no style entry,
/// and `get_list` refused a bare reference outright, while the 2D view of the
/// same item found the colour (Rust review finding G4).
///
/// Each variant asserts the style index entry for the fill item carries the
/// authored fill AND agrees with the 2D symbolic fill colour.
///
/// MUTATION that fails every variant: restore `style/fill.rs` to the parent
/// commit (`get_list(1)?` and `decode_by_id(attr.as_entity_ref()?).ok()?`).
#[test]
fn annotation_4406_fill_style_list_is_read_by_the_symbolic_rule() {
    let cases = [
        (
            "a dangling reference before the real style",
            FILL.replace(
                "#25=IFCSTYLEDITEM(#22,(#24),$);",
                "#25=IFCSTYLEDITEM(#22,(#98,#24),$);",
            ),
        ),
        (
            "a bare reference instead of a one-element list",
            FILL.replace(
                "#25=IFCSTYLEDITEM(#22,(#24),$);",
                "#25=IFCSTYLEDITEM(#22,#24,$);",
            ),
        ),
        (
            "a dangling reference inside an IFC2X3 style assignment",
            FILL.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))")
                .replace("(#23),.F.)", "(#23))")
                .replace(
                    "#25=IFCSTYLEDITEM(#22,(#24),$);",
                    "#26=IFCPRESENTATIONSTYLEASSIGNMENT((#98,#24));#25=IFCSTYLEDITEM(#22,(#26),$);",
                ),
        ),
    ];
    let mut failures = Vec::new();
    for (label, source) in cases {
        let mut spans = Vec::new();
        let mut scanner = ifc_lite_core::EntityScanner::new(source.as_bytes());
        while let Some((_, name, start, end)) = scanner.next_entity() {
            if name == "IFCSTYLEDITEM" {
                spans.push((start, end));
            }
        }
        let mut decoder = ifc_lite_core::EntityDecoder::new(&source);
        let index = ifc_lite_processing::prepass::resolve_styled_item_spans(&spans, &mut decoder);
        let Some(info) = index.get(&22) else {
            failures.push(format!("{label}: the fill item has no style entry"));
            continue;
        };
        let symbolic = ifc_lite_processing::extract_symbolic_data(&source);
        let agrees = !symbolic.fills.is_empty()
            && symbolic.fills.iter().all(|fill| {
                info.color
                    .iter()
                    .zip(fill.fill_color)
                    .all(|(a, b)| (a - b).abs() < 1e-6)
            });
        if info.material_name.as_deref() != Some("Cyan fill") || !agrees {
            failures.push(format!(
                "{label}: style index {:?} {:?} vs 2D fills {:?}",
                info.material_name,
                info.color,
                symbolic
                    .fills
                    .iter()
                    .map(|f| f.fill_color)
                    .collect::<Vec<_>>()
            ));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// The 3D surface-style readers take a bare reference where a list is expected
/// as a one-element list, as the fill reader above and the 2D symbolic index
/// do (#4694): in `IfcStyledItem.Styles`, in an IFC2X3
/// `IfcPresentationStyleAssignment.Styles`, `IfcSurfaceStyle.Styles`, and the
/// material chain's
/// `IfcStyledRepresentation.Items`.
///
/// MUTATION that fails every bare variant: remove the bare-reference arm from
/// `prepass::refs_from_list`.
#[test]
fn surface_style_list_accepts_a_bare_reference_4694() {
    const RED: [f32; 4] = [1.0, 0.0, 0.0, 1.0];
    let base = "ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('bare.ifc','2026-09-13T00:00:00',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyBareStylesRef01',$,'Proxy',$,$,#11,#12,$,$);#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#20=IFCSURFACESTYLE('Red',.BOTH.,(#21));#21=IFCSURFACESTYLESHADING(#22,$);#22=IFCCOLOURRGB($,1.,0.,0.);
#30=IFCSTYLEDITEM(#14,(#20),$);
ENDSEC;END-ISO-10303-21;";
    let cases = [
        ("a list (control)", base.to_string()),
        (
            "a bare Styles reference",
            base.replace("#30=IFCSTYLEDITEM(#14,(#20),$);", "#30=IFCSTYLEDITEM(#14,#20,$);"),
        ),
        (
            "a bare reference inside an IFC2X3 style assignment",
            base.replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))")
                .replace(
                    "#30=IFCSTYLEDITEM(#14,(#20),$);",
                    "#31=IFCPRESENTATIONSTYLEASSIGNMENT(#20);#30=IFCSTYLEDITEM(#14,(#31),$);",
                ),
        ),
        (
            "a bare surface-style element",
            base.replace(
                "#20=IFCSURFACESTYLE('Red',.BOTH.,(#21));",
                "#20=IFCSURFACESTYLE('Red',.BOTH.,#21);",
            ),
        ),
        (
            "a bare Items reference on a material's styled representation",
            base.replace(
                "#30=IFCSTYLEDITEM(#14,(#20),$);",
                "#30=IFCSTYLEDITEM($,(#20),$);#40=IFCMATERIAL('Red',$,$);\
                 #41=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#42),#40);\
                 #42=IFCSTYLEDREPRESENTATION(#2,'Style','Material',#30);\
                 #43=IFCRELASSOCIATESMATERIAL('2RelAssocBareItems001',$,$,$,(#10),#40);",
            ),
        ),
    ];
    let mut failures = Vec::new();
    for (label, source) in cases {
        let result = process_geometry(&source.as_bytes());
        let colors: Vec<_> = result
            .meshes
            .iter()
            .filter(|m| m.express_id == 10)
            .map(|m| m.color)
            .collect();
        // The proxy's default colour is grey, so red can only come from #20.
        let red = !colors.is_empty()
            && colors
                .iter()
                .all(|color| color.iter().zip(RED).all(|(a, b)| (a - b).abs() < 1e-6));
        if !red {
            failures.push(format!("{label}: {colors:?}"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
