// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5984: the finish join over the REAL pipeline's output, for the meshes the
//! #5582 join on `geometry_item_id` alone cannot reach: #957 type geometry
//! (no item id), and an occurrence whose style sits on its `IfcMappedItem`
//! rather than on the mapped leaf. Plus the `AC20-FZK-Haus.ifc` acceptance
//! values through [`ModelFinishes`], the join the server transports use.

use ifc_lite_processing::style::{ModelFinishes, SpecularMaterial};
use ifc_lite_processing::{process_geometry, MeshData};

/// `IFCSURFACESTYLERENDERING` with `SpecularColour = 0.75` -> roughness 0.25.
const GLOSSY: &str = "IFCSURFACESTYLERENDERING(#56,$,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.)";

fn header() -> &'static str {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-5984'),'2;1');
FILE_NAME('t.ifc','2026-09-25T00:00:00',(''),(''),'','','');
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
#52=IFCSURFACESTYLE($,.POSITIVE.,(#54));
#56=IFCCOLOURRGB($,0.6,0.5,0.4);
"#
}

fn footer() -> &'static str {
    "ENDSEC;\nEND-ISO-10303-21;\n"
}

/// Type-only geometry (#957): the finish is authored ONLY on the type's
/// representation map's item, and its meshes carry no `geometry_item_id`.
fn type_only() -> String {
    format!("{}#50=IFCSTYLEDITEM(#48,(#52),$);\n#54={GLOSSY};\n{}", header(), footer())
}

/// The same map instanced by an occurrence, styled on the occurrence's
/// `IfcMappedItem` (#104) and not on the leaf.
fn styled_mapped_item() -> String {
    format!(
        "{}#54={GLOSSY};\n\
         #100=IFCBUILDINGELEMENTPROXY('1occurrenceMapped0000',$,'Occ',$,$,#101,#102,$,.NOTDEFINED.);\n\
         #101=IFCLOCALPLACEMENT($,#5);\n\
         #102=IFCPRODUCTDEFINITIONSHAPE($,$,(#103));\n\
         #103=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#104));\n\
         #104=IFCMAPPEDITEM(#44,#105);\n\
         #105=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);\n\
         #110=IFCSTYLEDITEM(#104,(#52),$);\n{}",
        header(),
        footer()
    )
}

fn assert_glossy(finish: Option<SpecularMaterial>, what: &str) {
    let finish = finish.unwrap_or_else(|| panic!("{what}: no finish joined"));
    assert_eq!(finish.metallic, None, "{what}");
    let roughness = finish.roughness.unwrap_or_else(|| panic!("{what}: no roughness"));
    assert!((roughness - 0.25).abs() < 1e-6, "{what}: roughness {roughness}");
}

#[test]
fn type_geometry_gets_the_finish_authored_on_its_representation_map() {
    let content = type_only();
    let result = process_geometry(content.as_str());
    let type_meshes: Vec<&MeshData> = result.meshes.iter().filter(|m| m.express_id == 43).collect();
    assert_eq!(type_meshes.len(), 1, "the orphan type map renders once");
    assert_eq!(type_meshes[0].geometry_item_id, None, "type geometry names no item, so an item join misses it");
    let mut finishes = ModelFinishes::from_content(content.as_bytes());
    assert_glossy(finishes.finish_for_mesh(type_meshes[0]), "IfcBoilerType #43");
}

#[test]
fn an_occurrence_styled_on_its_mapped_item_gets_that_style_finish() {
    let content = styled_mapped_item();
    let result = process_geometry(content.as_str());
    let occ: Vec<&MeshData> = result.meshes.iter().filter(|m| m.express_id == 100).collect();
    assert_eq!(occ.len(), 1, "the occurrence renders");
    // The leaf #48 is unstyled; the colour came from #104's style via the
    // element walk, and so must the finish.
    let mut finishes = ModelFinishes::from_content(content.as_bytes());
    assert_glossy(finishes.finish_for_mesh(occ[0]), "occurrence #100");
}

#[test]
fn a_colour_that_is_not_the_styles_joins_no_finish() {
    // Recolour the type mesh: a colour that is not the map style's came from
    // somewhere colour-only (a material, the type default), so the element
    // fallback must refuse the map's finish.
    let content = type_only();
    let mut mesh = process_geometry(content.as_str()).meshes.into_iter().find(|m| m.express_id == 43).expect("type mesh");
    mesh.color = [0.9, 0.9, 0.9, 1.0];
    let mut finishes = ModelFinishes::from_content(content.as_bytes());
    assert_eq!(finishes.finish_for_mesh(&mesh), None);
}

/// Acceptance (#5984): the server-side join gives `AC20-FZK-Haus.ifc` the
/// same finishes the wasm path does: Glas 0, 'Kiefer, glänzend' 0.25,
/// 'Kiefer' 0.9, no metal.
#[test]
fn fzk_haus_finishes_through_the_model_join() {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/models/ara3d/AC20-FZK-Haus.ifc");
    let Ok(content) = std::fs::read_to_string(&path) else {
        eprintln!("AC20-FZK-Haus.ifc missing — run `pnpm fixtures`. Skipping #5984 fixture test.");
        return;
    };
    let result = process_geometry(content.as_str());
    let mut finishes = ModelFinishes::from_content(content.as_bytes());
    for (name, expected) in [("Glas", 0.0f32), ("Kiefer, gl\u{e4}nzend", 0.25), ("Kiefer", 0.9)] {
        let named: Vec<&MeshData> = result.meshes.iter().filter(|m| m.material_name.as_deref() == Some(name)).collect();
        assert!(!named.is_empty(), "expected meshes styled {name:?}");
        for m in named {
            let f = finishes.finish_for_mesh(m).unwrap_or_else(|| panic!("{name} mesh {} has no finish", m.express_id));
            assert_eq!(f.metallic, None, "{name} mesh {}", m.express_id);
            let r = f.roughness.unwrap_or_else(|| panic!("{name} mesh {} has no roughness", m.express_id));
            assert!((r - expected).abs() < 1e-6, "{name} mesh {}: roughness {r}, expected {expected}", m.express_id);
        }
    }
}
