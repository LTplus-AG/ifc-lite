// SPDX-License-Identifier: MPL-2.0
use ifc_lite_core::SourceBundle;
use std::sync::Arc;

const HEAD: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);#8=IFCDIRECTION((0.,0.,1.));
#9=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#10=IFCEXTRUDEDAREASOLID(#9,#5,#8,3.);#11=IFCEXTRUDEDAREASOLID(#9,#5,#8,1.);
";
pub(super) const WALL: &str = "#14=IFCWALL('w',$,'Wall',$,$,#7,#13,$,$);";
const MATERIAL: &str = "#15=IFCMATERIAL('Mat');#16=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#14),#15);\
    #30=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#31),#15);#31=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#32));\
    #32=IFCSTYLEDITEM($,(#33),$);";
pub(super) const WALL_GREY: [f32; 4] = [0.85, 0.85, 0.85, 1.];

/// One RGB surface style `#id` (its colour is `#id+1`, its rendering `#id+2`) with the given transparency.
pub(super) fn style(id: u32, rgb: [f64; 3], transparency: f64) -> String {
    format!("#{c}=IFCCOLOURRGB($,{:?},{:?},{:?});#{r}=IFCSURFACESTYLERENDERING(#{c},{transparency:?},$,$,$,$,$,$,.NOTDEFINED.);\
        #{id}=IFCSURFACESTYLE($,.BOTH.,(#{r}));", rgb[0], rgb[1], rgb[2], c = id + 1, r = id + 2)
}
/// A source whose body representation #12 holds `items`; `rest` adds the product and its styling.
pub(super) fn source(items: &str, rest: &str) -> Arc<SourceBundle> {
    SourceBundle::new(format!("{HEAD}#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',({items}));\
        #13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));{rest}ENDSEC;END-ISO-10303-21;").into_bytes())
}
/// The same direct-plus-material and material-only sources for the job and mesh witnesses.
pub(super) fn precedence_source(direct: bool) -> Arc<SourceBundle> {
    let styling = if direct {
        format!("#25=IFCSTYLEDITEM(#10,(#20),$);{}", style(20, [0.2, 0.4, 0.6], 0.3))
    } else {
        String::new()
    };
    source("#10", &format!("{WALL}{MATERIAL}{}{styling}", style(33, [0.9, 0.8, 0.1], 0.)))
}
