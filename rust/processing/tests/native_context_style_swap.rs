// SPDX-License-Identifier: MPL-2.0
//! #7955 E2b: the native run shares one immutable model snapshot across its
//! jobs and re-takes it when the deferred styled-item index replaces the
//! styles. A product meshed after that swap must see its own per-item styles,
//! not only the element colour the metadata phase resolved from the new map.
//!
//! `fast_first` with a first chunk of one job defers geometry styled items:
//! #10 meshes before the replay, #20 after it. #20 has two items styled red
//! and green; its element colour is the first item's red, so only the
//! producer's own style map can colour the second item green.

use ifc_lite_processing::{process, Batching, Features, ProcessingRequest};

const RED: [f32; 4] = [0.9, 0.1, 0.1, 1.0];
const GREEN: [f32; 4] = [0.1, 0.8, 0.2, 1.0];

const TWO_ITEM_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('E2b native snapshot swap'),'2;1');
FILE_NAME('swap.ifc','2026-10-21T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCLOCALPLACEMENT($,#5);
#8=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#9=IFCCARTESIANPOINTLIST3D(((5.,0.,0.),(6.,0.,0.),(5.,1.,0.),(5.,0.,1.)));
#10=IFCBUILDINGELEMENTPROXY('1ProxyBeforeReplay00',$,'First',$,$,#7,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));
#13=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#20=IFCBUILDINGELEMENTPROXY('1ProxyAfterReplay000',$,'Second',$,$,#7,#21,$,$);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#23,#24));
#23=IFCTRIANGULATEDFACESET(#8,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#24=IFCTRIANGULATEDFACESET(#9,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#30=IFCSTYLEDITEM(#23,(#31),$);
#31=IFCSURFACESTYLE('Red',.BOTH.,(#32));
#32=IFCSURFACESTYLERENDERING(#33,$,$,$,$,$,$,$,.FLAT.);
#33=IFCCOLOURRGB($,0.9,0.1,0.1);
#40=IFCSTYLEDITEM(#24,(#41),$);
#41=IFCSURFACESTYLE('Green',.BOTH.,(#42));
#42=IFCSURFACESTYLERENDERING(#43,$,$,$,$,$,$,$,.FLAT.);
#43=IFCCOLOURRGB($,0.1,0.8,0.2);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

fn item_colours(request: &ProcessingRequest) -> Vec<(Option<u32>, [f32; 4])> {
    let result = process(TWO_ITEM_IFC.as_bytes(), request, &mut ());
    let mut colours: Vec<_> = result
        .meshes
        .iter()
        .filter(|mesh| mesh.express_id == 20)
        .map(|mesh| (mesh.geometry_item_id, mesh.color))
        .collect();
    colours.sort_by_key(|(item, _)| *item);
    colours
}

#[test]
fn a_product_meshed_after_the_deferred_style_replay_keeps_its_per_item_styles() {
    let deferred = ProcessingRequest::default()
        .batching(Batching::new(1, 50).fast_first(true))
        .features(Features::default().presentation_layers(false));
    let colours = item_colours(&deferred);
    assert_eq!(
        colours.len(),
        2,
        "#20 renders one mesh per styled item: {colours:?}"
    );
    assert_eq!(colours[0].0, Some(23));
    assert!(approx_eq(colours[0].1, RED), "item #23: {:?}", colours[0].1);
    assert_eq!(colours[1].0, Some(24));
    assert!(
        approx_eq(colours[1].1, GREEN),
        "item #24 must take its own green from the re-taken snapshot, got {:?}",
        colours[1].1
    );
    // The up-front (non-deferred) run is the oracle: same colours, same items.
    let upfront =
        ProcessingRequest::default().features(Features::default().presentation_layers(false));
    assert_eq!(item_colours(&upfront), colours);
}
