// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #913 / #407 — the backend must colour an element from its associated
//! *material* appearance when there is no `IfcStyledItem` on the geometry.
//! Most BIM tools assign glass/frame appearance this way:
//!
//! ```text
//! #10 proxy ─IfcRelAssociatesMaterial→ #40 IfcMaterial
//!   #40 ─IfcMaterialDefinitionRepresentation #41→ #42 IfcStyledRepresentation
//!     └─ #30 orphan IfcStyledItem → #31 IfcSurfaceStyle → blue IfcColourRgb
//! ```
//!
//! Pre-fix the proxy rendered as the default gray; now it must be blue.

use ifc_lite_processing::{process, process_geometry, Batching, Features, ProcessingRequest};

const MATERIAL_BLUE: [f32; 4] = [0.2, 0.3, 0.8, 1.0];
const PROXY_DEFAULT: [f32; 4] = [0.6, 0.6, 0.6, 1.0];

/// No IfcStyledItem on the geometry — colour comes only from the material chain.
const MATERIAL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-407 material chain fixture'),'2;1');
FILE_NAME('mat.ifc','2026-06-03T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyMaterialChain0',$,'Proxy',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#30=IFCSTYLEDITEM($,(#31),$);
#31=IFCSURFACESTYLE('Glass',.BOTH.,(#32));
#32=IFCSURFACESTYLERENDERING(#33,$,$,$,$,$,$,$,.FLAT.);
#33=IFCCOLOURRGB($,0.2,0.3,0.8);
#40=IFCMATERIAL('Glass',$,$);
#41=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#42),#40);
#42=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#30));
#50=IFCRELASSOCIATESMATERIAL('2RelAssocMaterial000',$,$,$,(#10),#40);
ENDSEC;
END-ISO-10303-21;
"#;

fn approx_eq(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b.iter()).all(|(x, y)| (x - y).abs() < 1e-4)
}

#[test]
fn proxy_inherits_material_appearance() {
    let result = process_geometry(MATERIAL_IFC);

    let proxy = result
        .meshes
        .iter()
        .find(|m| m.express_id == 10)
        .expect("proxy #10 produced no mesh");

    assert!(
        approx_eq(proxy.color, MATERIAL_BLUE),
        "expected material colour {MATERIAL_BLUE:?}, got {:?} (default would be {PROXY_DEFAULT:?})",
        proxy.color
    );
}

#[test]
fn proxy_inherits_material_appearance_in_fast_first_batch_streaming() {
    // Regression for #913 §2c: the `fast_first_batch` streaming mode defers
    // geometry styled items, but orphan styled items (material appearances) are
    // resolved up front for the material chain — so they must NOT be deferred.
    // Pre-fix the deferred path collected no orphan styled items and this proxy
    // rendered the default gray; now it must be the material blue.
    // `defer_style_updates` = fast_first && Default opening filter &&
    // !presentation_layers: all three required to hit the deferred branch this
    // test guards.
    let request = ProcessingRequest::default()
        .batching(Batching::new(1, 50).fast_first(true))
        .features(Features::default().presentation_layers(false));
    let result = process(MATERIAL_IFC.as_bytes(), &request, &mut ());

    let proxy = result
        .meshes
        .iter()
        .find(|m| m.express_id == 10)
        .expect("proxy #10 produced no mesh in fast_first_batch streaming mode");

    assert!(
        approx_eq(proxy.color, MATERIAL_BLUE),
        "fast_first_batch streaming: expected material colour {MATERIAL_BLUE:?}, got {:?} \
         (default would be {PROXY_DEFAULT:?})",
        proxy.color
    );
}

/// PROCESSING-4 (#7691): a window whose `IfcMaterialList` is
/// `[glass (transparency 0.6), frame (opaque)]`. The glass comes FIRST, so a
/// "first colour" rule and a "first opaque colour" rule disagree here, and
/// only here.
const GLASS_FIRST_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('PROCESSING-4 element fallback fixture'),'2;1');
FILE_NAME('fallback.ifc','2026-10-16T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWINDOW('1WindowGlassFirst000',$,'Window',$,$,#11,#12,$,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#30=IFCSTYLEDITEM($,(#31),$);
#31=IFCSURFACESTYLE('Glass',.BOTH.,(#32));
#32=IFCSURFACESTYLERENDERING(#33,0.6,$,$,$,$,$,$,.FLAT.);
#33=IFCCOLOURRGB($,0.2,0.4,0.8);
#34=IFCSTYLEDITEM($,(#35),$);
#35=IFCSURFACESTYLE('Frame',.BOTH.,(#36));
#36=IFCSURFACESTYLERENDERING(#37,$,$,$,$,$,$,$,.FLAT.);
#37=IFCCOLOURRGB($,0.7,0.5,0.2);
#40=IFCMATERIAL('Glass',$,$);
#41=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#42),#40);
#42=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#30));
#45=IFCMATERIAL('Frame',$,$);
#46=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#47),#45);
#47=IFCSTYLEDREPRESENTATION(#2,'Style','Material',(#34));
#50=IFCMATERIALLIST((#40,#45));
#51=IFCRELASSOCIATESMATERIAL('2RelAssocMaterial001',$,$,$,(#10),#50);
ENDSEC;
END-ISO-10303-21;
"#;

/// PROCESSING-4 (#7691): the element-level material fallback colour the
/// browser wire carries (`styleIds`/`styleColors`, read back per element by
/// `processGeometryBatch`) must be the colour the native pipeline picks for
/// the same element (`style::pick_opaque_first` over the element's material
/// colours, `processor/mod.rs`). It used to be the FIRST colour, so this
/// window fell back to translucent glass in the viewer and to the opaque frame
/// on the server and in exports. Both wire builders are pinned: the serial
/// pre-pass and the sharded finalize.
#[test]
fn element_material_fallback_on_the_browser_wire_matches_native_processing_4() {
    use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
    use ifc_lite_processing::flat_styles_rgba8_from_geometry_columns;
    use ifc_lite_processing::prepass::{flat_styles_rgba8, resolve_prepass, PrepassSpans, ResolveOptions};
    use ifc_lite_processing::style::{pick_opaque_first, Rgba};

    const WINDOW: u32 = 10;
    const FRAME: [f32; 4] = [0.7, 0.5, 0.2, 1.0];
    let content = GLASS_FIRST_IFC.as_bytes();
    let mut decoder = EntityDecoder::with_arc_index(content, std::sync::Arc::new(build_entity_index(content)));
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        spans.stash(type_name, id, start, end);
    }
    let resolved = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());

    let colours = &resolved.element_material_colors[&WINDOW];
    assert_eq!(colours.len(), 2, "the window joins both list materials: {colours:?}");
    assert!(colours[0][3] < 0.95, "fixture: the transparent glass must come first: {colours:?}");
    let native = pick_opaque_first(colours).expect("the window has material colours");
    assert!(approx_eq(native, FRAME), "native picks the opaque frame, got {native:?}");
    let expected = Rgba::from_array(native).to_rgba8();

    let wire_colour = |ids: &[u32], rgba: &[u8]| -> [u8; 4] {
        let at = ids.iter().position(|&id| id == WINDOW).expect("the window is on the style wire");
        rgba[at * 4..at * 4 + 4].try_into().unwrap()
    };
    let (ids, rgba) = flat_styles_rgba8(&resolved, &mut decoder);
    assert_eq!(wire_colour(&ids, &rgba), expected, "serial pre-pass wire disagrees with native");

    // The sharded finalize takes geometry styles as columns; this fixture has
    // none attached to geometry, so the columns are empty.
    let (ids, rgba) = flat_styles_rgba8_from_geometry_columns(&[], &[], &resolved, &mut decoder);
    assert_eq!(wire_colour(&ids, &rgba), expected, "sharded pre-pass wire disagrees with native");
}
