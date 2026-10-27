// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{admit_product, RetainedProductRefusal};
const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#17=IFCAXIS2PLACEMENT3D(#18,$,$);#18=IFCCARTESIANPOINT((-4.,3.,2.));
#19=IFCLOCALPLACEMENT($,#17);#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#50=IFCALIGNMENT('a',$,'Road',$,$,$,$,#53);
#51=IFCCARTESIANPOINT((0.,0.,0.));#52=IFCCARTESIANPOINT((10.,0.,0.));#53=IFCPOLYLINE((#51,#52));
#60=IFCBOILERTYPE('t',$,'Library',$,$,$,(#61,#71),$,$,.NOTDEFINED.);
#61=IFCREPRESENTATIONMAP(#7,#12);#71=IFCREPRESENTATIONMAP(#17,#22);
ENDSEC;END-ISO-10303-21;";
const LAYERS: &str = "#80=IFCMATERIALLAYER($,0.1,$);#81=IFCMATERIALLAYER($,0.2,$);#82=IFCMATERIALLAYERSET((#80,#81),'layers');#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.POSITIVE.,0.);#84=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#10),#83);";
const OPENING: &str =
    "#30=IFCOPENINGELEMENT('o',$,$,$,$,#19,#21,$,$);#31=IFCRELVOIDSELEMENT('v',$,$,$,#10,#30);";

fn refusal(text: &str, id: u32) -> RetainedProductRefusal {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    admit_product(source.clone(), &mut decoder, id)
        .unwrap_err()
        .refusal()
}
// Refs #7955: observes the real admission refusal, not an executor error constructor.
#[test]
fn layered_wall_refuses_before_execution() {
    let text = SOURCE.replace(
        "ENDSEC;END-ISO-10303-21;",
        &format!("{LAYERS}ENDSEC;END-ISO-10303-21;"),
    );
    assert_eq!(
        refusal(&text, 10),
        RetainedProductRefusal::MaterialLayerStrategy
    );
    assert_eq!(refusal(&text, 10).code(), "material_layer_strategy");
}
#[test]
fn openings_precede_layers_on_the_same_wall() {
    let text = SOURCE.replace(
        "ENDSEC;END-ISO-10303-21;",
        &format!("{LAYERS}{OPENING}ENDSEC;END-ISO-10303-21;"),
    );
    assert_eq!(refusal(&text, 10), RetainedProductRefusal::OpeningStrategy);
}
#[test]
fn curved_fixture_keeps_opening_strategy() {
    let text = include_str!("../../../tests/fixtures/synthetic-retained/f-a-curved.ifc");
    for id in [55, 122, 188, 254] {
        assert_eq!(refusal(text, id).code(), "opening_strategy", "product {id}");
    }
}
#[test]
fn plain_extrusion_admits_without_a_numerical_worker() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    assert!(admit_product(source.clone(), &mut decoder, 10).is_ok());
}
