// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #957 — geometry attached to an `IfcTypeProduct` via its
//! `RepresentationMaps`, with no occurrence to instantiate it, must still
//! render (buildingSMART annex-E "tessellated shape with style" showcase
//! files), and normally-instanced typed products must NOT be double-rendered.

use ifc_lite_processing::process_geometry;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

const WHITE: [f32; 4] = [1.0, 1.0, 1.0, 1.0];

/// An IfcBoilerType whose tessellated tetrahedron hangs off a RepresentationMap
/// with NO IfcBoiler occurrence — styled white via IfcStyledItem (no
/// IfcStyledItem on a product, only on the type's mapped geometry).
const TYPE_ONLY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-957 type-only geometry'),'2;1');
FILE_NAME('t.ifc','2026-06-06T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#50=IFCSTYLEDITEM(#48,(#52),$);
#52=IFCSURFACESTYLE($,.POSITIVE.,(#54));
#54=IFCSURFACESTYLERENDERING(#56,$,$,$,$,$,$,$,.NOTDEFINED.);
#56=IFCCOLOURRGB($,1.,1.,1.);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn type_only_representation_map_renders() {
    let result = process_geometry(TYPE_ONLY_IFC);

    let type_meshes: Vec<&_> = result.meshes.iter().filter(|m| m.express_id == 43).collect();
    assert_eq!(
        type_meshes.len(),
        1,
        "IfcBoilerType #43 type-only geometry should render exactly one mesh; got {:?}",
        result
            .meshes
            .iter()
            .map(|m| (m.express_id, m.ifc_type.as_str()))
            .collect::<Vec<_>>()
    );

    let mesh = type_meshes[0];
    assert_eq!(mesh.indices.len() / 3, 4, "tetrahedron should produce 4 triangles");
    assert!(
        approx_eq(mesh.color, WHITE),
        "type geometry should inherit the authored white IfcSurfaceStyle, got {:?}",
        mesh.color
    );
}

/// The same type, now INSTANCED by an IfcBuildingElementProxy whose
/// MappedRepresentation references the type's RepresentationMap via an
/// IfcMappedItem. The occurrence renders; the type's RepresentationMap is no
/// longer orphan, so it must NOT be rendered a second time.
const INSTANCED_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-957 instanced type (no double-render)'),'2;1');
FILE_NAME('t.ifc','2026-06-06T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#100=IFCBUILDINGELEMENTPROXY('1occurrenceMapped0000',$,'Occ',$,$,#101,#102,$,.NOTDEFINED.);
#101=IFCLOCALPLACEMENT($,#5);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#104));
#104=IFCMAPPEDITEM(#44,#105);
#105=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn instanced_type_is_not_double_rendered() {
    let result = process_geometry(INSTANCED_IFC);

    let occurrence = result.meshes.iter().filter(|m| m.express_id == 100).count();
    let type_direct = result.meshes.iter().filter(|m| m.express_id == 43).count();

    assert_eq!(occurrence, 1, "the IfcMappedItem occurrence #100 should render");
    assert_eq!(
        type_direct, 0,
        "the referenced RepresentationMap must NOT also render as orphan type geometry"
    );
}

/// The real-world regression behind the "duplicate boxes at wrong positions"
/// report: ArchiCAD/AC20 exports attach a RepresentationMap to a typed product
/// (e.g. IfcDoorType) while the OCCURRENCE carries its own DIRECT body geometry —
/// it does NOT reference the type's map via an IfcMappedItem. The type and the
/// occurrence are linked only by IfcRelDefinesByType. The map is therefore
/// referenced by no IfcMappedItem, so the #957 orphan test alone would treat it as
/// orphan and render it at its MappingOrigin — a duplicate of the door at the
/// wrong position. The IfcRelDefinesByType gate must suppress it.
const INSTANCED_DIRECT_GEOMETRY_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-957 instanced type, direct-geometry occurrence'),'2;1');
FILE_NAME('t.ifc','2026-06-07T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#43=IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A',$,'Boiler',$,$,$,(#44),$,$,.NOTDEFINED.);
#44=IFCREPRESENTATIONMAP(#45,#46);
#45=IFCAXIS2PLACEMENT3D(#4,$,$);
#46=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#48));
#48=IFCTRIANGULATEDFACESET(#49,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#49=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#100=IFCBOILER('1occurrenceDirect000',$,'Occ',$,$,#101,#102,$,.NOTDEFINED.);
#101=IFCLOCALPLACEMENT($,#5);
#102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));
#103=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#106));
#106=IFCTRIANGULATEDFACESET(#107,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#107=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(2.,0.,0.),(0.,2.,0.),(0.,0.,2.)));
#110=IFCRELDEFINESBYTYPE('3defByTypeLink00000000',$,$,$,(#100),#43);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn instanced_type_with_direct_geometry_occurrence_is_not_double_rendered() {
    let result = process_geometry(INSTANCED_DIRECT_GEOMETRY_IFC);

    let occurrence = result.meshes.iter().filter(|m| m.express_id == 100).count();
    let type_direct = result.meshes.iter().filter(|m| m.express_id == 43).count();

    assert_eq!(
        occurrence, 1,
        "the IfcBoiler occurrence #100 (direct body geometry) should render"
    );
    assert_eq!(
        type_direct, 0,
        "an IfcRelDefinesByType-instanced type must NOT render its RepresentationMap \
         as orphan type geometry (the AC20 duplicate-box regression), even though no \
         IfcMappedItem references the map"
    );
}
