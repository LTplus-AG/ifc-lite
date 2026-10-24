// SPDX-License-Identifier: MPL-2.0
//! #7955 BROWSER02: independent IFC sources with colliding STEP identifiers.
use super::*;
use wasm_bindgen_test::wasm_bindgen_test;
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
fn bind(api: &IfcAPI, bytes: &str) -> RetainedBrowserModel {
    api.bind_retained_model(bytes.as_bytes().to_vec()).unwrap()
}
fn layers() -> String {
    SOURCE.replace("ENDSEC;END-ISO-10303-21;", "
#80=IFCMATERIAL('Layer',$,$);
#81=IFCMATERIALLAYER(#80,0.2,$,$,$,$,$);
#82=IFCMATERIALLAYERSET((#81),'Layers',$);
#83=IFCMATERIALLAYERSETUSAGE(#82,.AXIS2.,.POSITIVE.,0.,$);
#84=IFCRELASSOCIATESMATERIAL('mat',$,$,$,(#10),#83);
#85=IFCBUILDINGELEMENTPART('part',$,$,$,$,#9,#11,$,$);
#86=IFCRELAGGREGATES('parts',$,$,$,#10,(#85));
ENDSEC;END-ISO-10303-21;")
}
#[wasm_bindgen_test]
fn retained_browser_independent_maps_match_fresh_api_without_mutating_ordinary_cache() {
    let api = IfcAPI::new();
    let a = SOURCE.replace("ENDSEC;END-ISO-10303-21;", "
#90=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
#91=IFCMAPPEDITEM(#61,#90);
ENDSEC;END-ISO-10303-21;");
    // Warm the actual ordinary cache as well as binding A; B must neither reuse
    // it nor clear/replace it while ordinary A remains active.
    let source = SourceBundle::new(a.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let cached = api.get_or_build_referenced_repmaps(a.as_bytes(), &mut decoder);
    assert!(cached.contains(&61));
    let _a = bind(&api, &a);
    let b = SOURCE.replace("(#61,#71)", "(#61)");
    let fresh = bind(&IfcAPI::new(), &b);
    let shared = bind(&api, &b);
    assert!(fresh.admit_product(60).is_ok());
    assert!(shared.admit_product(60).is_ok(), "BROWSER02_MAP: B admission equals fresh API");
    let after = api.get_or_build_referenced_repmaps(a.as_bytes(), &mut decoder);
    assert!(Arc::ptr_eq(&cached, &after), "ordinary cache ownership is preserved");
    assert!(!Arc::ptr_eq(&fresh.data.source, &shared.data.source));
}
#[wasm_bindgen_test]
fn retained_browser_independent_parts_and_layers_match_fresh_api() {
    for merge in [true, false] {
        let api = IfcAPI::new(); api.set_merge_layers(merge);
        let a = layers();
        let source = SourceBundle::new(a.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let cached = api.get_or_build_parts_to_skip(a.as_bytes(), &mut decoder);
        assert!(cached.contains(&85), "fixture part belongs to sliceable parent");
        let old_layers = api.get_or_build_material_layer_index(a.as_bytes(), &mut decoder);
        assert!(old_layers.is_sliceable(10));
        let _a = bind(&api, &a);
        let b = SOURCE.replace("#20=IFCSLAB", "#85=IFCSLAB");
        let fresh_api = IfcAPI::new(); fresh_api.set_merge_layers(merge);
        let fresh = bind(&fresh_api, &b);
        let shared = bind(&api, &b);
        assert!(fresh.admit_product(85).is_ok());
        assert!(shared.admit_product(85).is_ok(), "BROWSER02_PART: B admission equals fresh API");
        assert!(shared.admit_product(10).is_ok());
        if !merge {
            assert_eq!(shared.data.layers.as_ref().unwrap().sliceable_count(),
                fresh.data.layers.as_ref().unwrap().sliceable_count(), "BROWSER02_LAYER: source-owned layer index");
            assert!(!shared.data.layers.as_ref().unwrap().is_sliceable(10));
        }
        assert!(Arc::ptr_eq(&cached, &api.get_or_build_parts_to_skip(a.as_bytes(), &mut decoder)));
        assert!(Arc::ptr_eq(&old_layers, &api.get_or_build_material_layer_index(a.as_bytes(), &mut decoder)));
    }
}
