// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// One wall `#100` whose `IfcProductDefinitionShape` lists `reps`, plus the
/// extra `entities`. `#140` (4 x 0.3 x 2.5 m) and `#240` (1 x 1 x 1 m) are
/// extrusions; `#13` is the Body context.
pub fn wall(reps: &str, entities: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('profile-extractor walk'),'2;1');
FILE_NAME('f.ifc','2026-10-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0ExtractorWalkProj00A',$,'P',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#110=IFCLOCALPLACEMENT($,#111);
#111=IFCAXIS2PLACEMENT3D(#12,$,$);
#130=IFCRECTANGLEPROFILEDEF(.AREA.,'Wall',#131,4.,0.3);
#131=IFCAXIS2PLACEMENT2D(#132,#133);
#132=IFCCARTESIANPOINT((0.,0.));
#133=IFCDIRECTION((1.,0.));
#140=IFCEXTRUDEDAREASOLID(#130,#141,#142,2.5);
#141=IFCAXIS2PLACEMENT3D(#12,$,$);
#142=IFCDIRECTION((0.,0.,1.));
#230=IFCRECTANGLEPROFILEDEF(.AREA.,'Block',#131,1.,1.);
#240=IFCEXTRUDEDAREASOLID(#230,#141,#142,1.);
#151=IFCPRODUCTDEFINITIONSHAPE($,$,({reps}));
#100=IFCWALL('0ExtractorWalkWall00A',$,'Wall',$,$,#110,#151,$,$);
{entities}
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// `IfcMappedItem` `#{item}` over map `#{item+1}` whose representation
/// `#{item+2}` holds `items`.
pub fn mapped(item: u32, items: &str) -> String {
    let (map, rep) = (item + 1, item + 2);
    format!(
        "#{item}=IFCMAPPEDITEM(#{map},#99);\n\
         #{map}=IFCREPRESENTATIONMAP(#11,#{rep});\n\
         #{rep}=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',({items}));\n"
    )
}

pub const TARGET: &str = "#99=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#12,1.,$);";

/// A chain of `levels` mapped items, `#1000`, `#1003`, ..., the innermost
/// holding `#240`. The wall's mapped representation is `#160`.
pub fn chain(levels: u32) -> String {
    let mut entities = format!("{TARGET}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n");
    for level in 0..levels {
        let item = 1000 + 3 * level;
        let inner = if level + 1 == levels { "#240".to_string() } else { format!("#{}", item + 3) };
        entities.push_str(&mapped(item, &inner));
    }
    wall("#160", &entities)
}
