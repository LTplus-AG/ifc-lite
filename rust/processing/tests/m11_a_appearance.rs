// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M11-A, SMLib-free: the plan and its bindings come from real source walks and the maps from the real
//! prepass; no kernel, no mesh. Every expected colour is authored in the source text below, never read back
//! from the resolver under test.
use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType, SourceBundle};
use ifc_lite_geometry::program::transactions::{Plan, Program, Traversal};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::retained_runtime::{resolve_appearances, PartAppearance};
use ifc_lite_processing::element::OwnedMeshProductionData;
use ifc_lite_processing::prepass::{resolve_prepass, PrepassSpans};
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
const WALL: &str = "#14=IFCWALL('w',$,'Wall',$,$,#7,#13,$,$);";
const MATERIAL: &str = "#15=IFCMATERIAL('Mat');#16=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#14),#15);\
    #30=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#31),#15);#31=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#32));\
    #32=IFCSTYLEDITEM($,(#33),$);";
const WALL_GREY: [f32; 4] = [0.85, 0.85, 0.85, 1.];

/// One RGB surface style `#id` (its colour is `#id+1`, its rendering `#id+2`) with the given transparency.
fn style(id: u32, rgb: [f64; 3], transparency: f64) -> String {
    format!("#{c}=IFCCOLOURRGB($,{:?},{:?},{:?});#{r}=IFCSURFACESTYLERENDERING(#{c},{transparency:?},$,$,$,$,$,$,.NOTDEFINED.);\
        #{id}=IFCSURFACESTYLE($,.BOTH.,(#{r}));", rgb[0], rgb[1], rgb[2], c = id + 1, r = id + 2)
}
/// A source whose body representation #12 holds `items`; `rest` adds the product and its styling.
fn source(items: &str, rest: &str) -> Arc<SourceBundle> {
    SourceBundle::new(format!("{HEAD}#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',({items}));\
        #13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));{rest}ENDSEC;END-ISO-10303-21;").into_bytes())
}
/// The maps the retained model run builds from the same source (`session_retained::model::run_model`).
fn maps(source: &Arc<SourceBundle>) -> OwnedMeshProductionData {
    let mut decoder = source.decoder();
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(source.bytes());
    while let Some((id, name, start, end)) = scanner.next_entity() {
        spans.stash(name, id, start, end);
    }
    let resolved = resolve_prepass(&spans, &mut decoder, Default::default());
    OwnedMeshProductionData {
        geometry_style_index: Arc::new(resolved.geometry_style_index),
        indexed_colour_full: Arc::new(resolved.indexed_colour_full),
        element_material_colors: Arc::new(resolved.element_material_colors),
        ..Default::default()
    }
}
fn walk(program: &mut Program<'_>, router: &GeometryRouter, decoder: &mut EntityDecoder) {
    while let Some(ticket) = program.request().unwrap() {
        let (reply, _, _storage) = program.admit(ticket, router, decoder).unwrap();
        program.accept(reply, router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
}
fn product_plan(source: &Arc<SourceBundle>, id: u32, plain: bool) -> Plan {
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
    let entity = decoder.decode_by_id(id).unwrap();
    let textures = Default::default();
    let traversal = Traversal::new(1, 1);
    let mut program = if plain { traversal.product_parts(&entity) } else { traversal.product_submeshes(&entity, &textures) };
    walk(&mut program, &router, &mut decoder);
    program.finish().unwrap()
}
fn type_plan(source: &Arc<SourceBundle>, map: u32, type_id: u32, class: u8, color: [f32; 4]) -> Plan {
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
    let textures = Default::default();
    let mut program = Traversal::new(1, 1).type_map(decoder.decode_by_id(map).unwrap(), &textures);
    walk(&mut program, &router, &mut decoder);
    Plan::type_maps(vec![program.finish_type_map(type_id, class, color).unwrap()]).unwrap()
}
fn appearances(source: &Arc<SourceBundle>, plan: &Plan, id: u32, ifc_type: IfcType, fallback: [f32; 4]) -> Vec<PartAppearance> {
    resolve_appearances(source, maps(source), id, &ifc_type, plan, fallback).unwrap()
}
fn near(actual: [f32; 4], expected: [f32; 4]) {
    assert!(actual.iter().zip(expected).all(|(a, e)| (a - e).abs() < 1e-6), "{actual:?} != {expected:?}");
}

#[test]
fn m11_a_direct_item_style_wins_over_a_material_colour() {
    // A direct style on the item: RGB (.2,.4,.6), transparency .3 => alpha .7. A material also colours the
    // wall, and the direct style must win (#913 precedence).
    let rest = format!("{WALL}{MATERIAL}{}#25=IFCSTYLEDITEM(#10,(#20),$);{}",
        style(33, [0.9, 0.8, 0.1], 0.), style(20, [0.2, 0.4, 0.6], 0.3));
    let source = source("#10", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWall, WALL_GREY);
    assert_eq!(parts.len(), 1);
    near(parts[0].rgba, [0.2, 0.4, 0.6, 0.7]);
    assert_eq!((parts[0].geometry_item_id, parts[0].style_id, parts[0].geometry_class), (Some(10), Some(10), 0));
}

#[test]
fn m11_a_material_colour_then_the_element_colour_when_nothing_styles_the_item() {
    let source = source("#10", &format!("{WALL}{MATERIAL}{}", style(33, [0.9, 0.8, 0.1], 0.)));
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWall, WALL_GREY);
    near(parts[0].rgba, [0.9, 0.8, 0.1, 1.]);
    assert_eq!(parts[0].style_id, None, "the colour did not come from a styled item");
    let bare = self::source("#10", WALL);
    let parts = appearances(&bare, &product_plan(&bare, 14, false), 14, IfcType::IfcWall, WALL_GREY);
    near(parts[0].rgba, WALL_GREY);
    assert_eq!(parts[0].material_name, None);
}

#[test]
fn m11_a_an_unstyled_item_takes_the_first_style_of_its_representation_as_exact_does() {
    // Exact's job colour is the first styled item under the product's shape, and an item with no style of
    // its own, no material and no mapped chase falls back to it: #10 renders as #11 does.
    let rest = format!("{WALL}#25=IFCSTYLEDITEM(#11,(#20),$);{}", style(20, [0.3, 0.3, 0.7], 0.));
    let source = source("#10,#11", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWall, WALL_GREY);
    near(parts[0].rgba, [0.3, 0.3, 0.7, 1.]);
    near(parts[1].rgba, [0.3, 0.3, 0.7, 1.]);
    assert_eq!((parts[0].style_id, parts[1].style_id), (None, Some(11)));
}

#[test]
fn m11_a_opening_elements_render_with_the_fixed_display_colour_not_their_authored_style() {
    // IfcOpeningElement is a virtual subtraction volume: its authored style says nothing about appearance,
    // and the display contract is the fixed (1.0, .42, .29, .4) (#5409).
    let rest = format!("#14=IFCOPENINGELEMENT('o',$,'O',$,$,#7,#13,$,.OPENING.);#25=IFCSTYLEDITEM(#10,(#20),$);{}",
        style(20, [0.1, 0.9, 0.1], 0.));
    let source = source("#10", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcOpeningElement, [1.0, 0.42, 0.29, 0.4]);
    near(parts[0].rgba, [1.0, 0.42, 0.29, 0.4]);
    assert_eq!(parts[0].geometry_item_id, Some(10), "the item identity survives the override");
}

#[test]
fn m11_a_material_cursor_alternates_glass_then_frame_across_a_windows_parts() {
    // Two unstyled items, materials [glass(alpha .35), frame(opaque)]: part 0 prefers transparent, part 1
    // opaque, as the one cursor of exact's collection does.
    let rest = format!("#14=IFCWINDOW('w',$,'Win',$,$,#7,#13,$,1.,1.,$,$,$);\
        #15=IFCMATERIAL('Glass');#16=IFCMATERIAL('Frame');#17=IFCMATERIALLIST((#15,#16));\
        #18=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#14),#17);\
        #30=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#31),#15);#31=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#32));\
        #32=IFCSTYLEDITEM($,(#33),$);{}\
        #50=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#51),#16);#51=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#52));\
        #52=IFCSTYLEDITEM($,(#53),$);{}", style(33, [0.6, 0.8, 1.0], 0.65), style(53, [0.3, 0.2, 0.1], 0.));
    let source = source("#10,#11", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWindow, [0.6, 0.8, 1.0, 0.4]);
    assert_eq!(parts.len(), 2);
    near(parts[0].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(parts[1].rgba, [0.3, 0.2, 0.1, 1.]);
    assert_eq!(parts[0].material_name.as_deref(), Some("Window_Glass"));
    assert_eq!(parts[1].material_name, Some(format!("Window_Frame_{}", parts[1].geometry_item_id.unwrap())));
}

#[test]
fn m11_a_orphan_type_map_takes_its_item_style_else_the_type_colour_with_its_class() {
    let map = "#60=IFCBOILERTYPE('t',$,'T',$,$,$,(#61),$,$,.NOTDEFINED.);#61=IFCREPRESENTATIONMAP(#5,#12);";
    let styled = source("#10", &format!("{map}#25=IFCSTYLEDITEM(#10,(#20),$);{}", style(20, [0.3, 0.6, 0.9], 0.5)));
    let plan = type_plan(&styled, 61, 60, 1, [0.5, 0.5, 0.5, 1.]);
    let parts = appearances(&styled, &plan, 60, IfcType::IfcBoilerType, [0.5, 0.5, 0.5, 1.]);
    near(parts[0].rgba, [0.3, 0.6, 0.9, 0.5]);
    assert_eq!((parts[0].geometry_class, parts[0].geometry_item_id), (1, None));
    let plain = source("#10", map);
    let plan = type_plan(&plain, 61, 60, 2, [0.5, 0.5, 0.5, 1.]);
    let parts = appearances(&plain, &plan, 60, IfcType::IfcBoilerType, [0.5, 0.5, 0.5, 1.]);
    near(parts[0].rgba, [0.5, 0.5, 0.5, 1.]);
    assert_eq!(parts[0].geometry_class, 2);
}

#[test]
fn m11_a_an_unbound_frame_part_takes_the_element_colour_as_exact_fallback_bodies_do() {
    // `PlainParts` walks bind no style: exact colours the part with the job colour, names no item and no
    // material. The job colour is the first style under the shape, so #11 styles #10's part.
    let rest = format!("{WALL}#25=IFCSTYLEDITEM(#11,(#20),$);{}", style(20, [0.3, 0.3, 0.7], 0.));
    let source = source("#10,#11", &rest);
    let plan = product_plan(&source, 14, true);
    assert!(plan.values().all(|value| value.presentation().next().is_none()), "frame parts carry no binding");
    let parts = appearances(&source, &plan, 14, IfcType::IfcWall, WALL_GREY);
    assert!(!parts.is_empty());
    for part in &parts {
        near(part.rgba, [0.3, 0.3, 0.7, 1.]);
        assert_eq!((part.geometry_item_id, part.material_name.as_deref()), (None, None));
    }
}

// ---- Mapped occurrences. Exact keys a styled sub-mesh by the LEAF item the walk reached
// (`mapping_accept.rs`: `Merging::Styled(item.item().id, ..)`) and calls `color` once per leaf, so an enclosing
// IfcMappedItem never decides. Each expectation below is authored from those rules, not read from the resolver.
const OCCURRENCE: &str = "#42=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);";
const WINDOW: &str = "#14=IFCWINDOW('w',$,'Win',$,$,#7,#13,$,1.,1.,$,$,$);";
/// Materials [glass(alpha .35), frame(opaque)] on #14.
fn glass_and_frame() -> String {
    format!("#15=IFCMATERIAL('Glass');#16=IFCMATERIAL('Frame');#17=IFCMATERIALLIST((#15,#16));\
        #18=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#14),#17);\
        #30=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#31),#15);#31=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#32));\
        #32=IFCSTYLEDITEM($,(#33),$);{}\
        #50=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#51),#16);#51=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#52));\
        #52=IFCSTYLEDITEM($,(#53),$);{}", style(33, [0.6, 0.8, 1.0], 0.65), style(53, [0.3, 0.2, 0.1], 0.))
}
/// The one map #41 over a representation #40 of `items`.
fn map_of(items: &str) -> String {
    format!("#40=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',({items}));#41=IFCREPRESENTATIONMAP(#5,#40);{OCCURRENCE}")
}

#[test]
fn m11_a_a_mapped_windows_leaves_keep_their_own_style_name_and_item() {
    // Body = ONE IfcMappedItem #43 -> map of [#10 glass-styled, #11 frame-styled]. Exact: two sub-meshes keyed #10 and
    // #11, coloured by their own styles; Window_Glass (alpha .35 <= .65) and Window_Frame_<leaf id>.
    let rest = format!("{WINDOW}{}#43=IFCMAPPEDITEM(#41,#42);#25=IFCSTYLEDITEM(#10,(#20),$);#26=IFCSTYLEDITEM(#11,(#27),$);{}{}",
        map_of("#10,#11"), style(20, [0.6, 0.8, 1.0], 0.65), style(27, [0.3, 0.2, 0.1], 0.));
    let source = source("#43", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWindow, [0.6, 0.8, 1.0, 0.4]);
    assert_eq!(parts.len(), 2);
    near(parts[0].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(parts[1].rgba, [0.3, 0.2, 0.1, 1.]);
    assert_eq!((parts[0].geometry_item_id, parts[1].geometry_item_id), (Some(10), Some(11)));
    assert_eq!(parts[0].material_name.as_deref(), Some("Window_Glass"));
    assert_eq!(parts[1].material_name.as_deref(), Some("Window_Frame_11"));
}

#[test]
fn m11_a_the_material_cursor_runs_across_the_leaves_of_a_map() {
    // The same window with UNSTYLED leaves and materials [glass, frame]: one cursor per product over the leaves, so
    // glass (step 0) then frame (step 1). Keyed by the map, both parts would take the one resolution (glass).
    let rest = format!("{WINDOW}{}#43=IFCMAPPEDITEM(#41,#42);{}", map_of("#10,#11"), glass_and_frame());
    let source = source("#43", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWindow, [0.6, 0.8, 1.0, 0.4]);
    assert_eq!(parts.len(), 2);
    near(parts[0].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(parts[1].rgba, [0.3, 0.2, 0.1, 1.]);
    assert_eq!((parts[0].geometry_item_id, parts[1].geometry_item_id), (Some(10), Some(11)));
    assert_eq!(parts[0].material_name.as_deref(), Some("Window_Glass"));
    assert_eq!(parts[1].material_name.as_deref(), Some("Window_Frame_11"));
}

#[test]
fn m11_a_one_leaf_under_two_occurrences_is_two_sub_meshes_with_two_cursor_steps() {
    // One single-leaf map used by two IfcMappedItems of the same window: exact walks both, so the leaf is two
    // sub-meshes and the cursor moves twice (glass, then frame).
    let rest = format!("{WINDOW}{}#43=IFCMAPPEDITEM(#41,#42);#44=IFCMAPPEDITEM(#41,#42);{}", map_of("#10"), glass_and_frame());
    let source = source("#43,#44", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWindow, [0.6, 0.8, 1.0, 0.4]);
    assert_eq!(parts.len(), 2);
    near(parts[0].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(parts[1].rgba, [0.3, 0.2, 0.1, 1.]);
    assert_eq!((parts[0].geometry_item_id, parts[1].geometry_item_id), (Some(10), Some(10)));
}

#[test]
fn m11_a_a_style_on_the_mapped_item_reaches_a_bare_leaf_only_as_the_element_colour() {
    // #10 is styled red; #11 is bare; the IfcMappedItem itself is styled blue. Exact: #10 keeps its direct style; #11
    // has no style, no chase (it is not a mapped item) and no material, so it takes the element colour, which is the
    // first style the product reaches: the mapped item's own (blue). Keyed by the map, #10 would turn blue too.
    let rest = format!("{WALL}{}#43=IFCMAPPEDITEM(#41,#42);#25=IFCSTYLEDITEM(#10,(#20),$);#26=IFCSTYLEDITEM(#43,(#27),$);{}{}",
        map_of("#10,#11"), style(20, [0.75, 0.25, 0.25], 0.), style(27, [0.25, 0.25, 0.75], 0.));
    let source = source("#43", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWall, WALL_GREY);
    assert_eq!(parts.len(), 2);
    near(parts[0].rgba, [0.75, 0.25, 0.25, 1.]);
    near(parts[1].rgba, [0.25, 0.25, 0.75, 1.]);
    assert_eq!((parts[0].geometry_item_id, parts[1].geometry_item_id), (Some(10), Some(11)));
    assert_eq!((parts[0].style_id, parts[1].style_id), (Some(10), None));
}

#[test]
fn m11_a_a_nested_map_keeps_the_leaf_of_every_level() {
    // Body = #46 -> map #45 of [#43 -> map #41 of [#10 green], #47 -> map #49 of [#11 yellow]]. Exact keys the leaves #10
    // and #11, each inside two enclosing occurrences; neither occurrence is a sub-mesh.
    let rest = format!("{WALL}{}#43=IFCMAPPEDITEM(#41,#42);\
        #48=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#11));#49=IFCREPRESENTATIONMAP(#5,#48);#47=IFCMAPPEDITEM(#49,#42);\
        #44=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#43,#47));#45=IFCREPRESENTATIONMAP(#5,#44);#46=IFCMAPPEDITEM(#45,#42);\
        #25=IFCSTYLEDITEM(#10,(#20),$);#26=IFCSTYLEDITEM(#11,(#27),$);{}{}",
        map_of("#10"), style(20, [0.25, 0.75, 0.25], 0.), style(27, [0.75, 0.75, 0.25], 0.));
    let source = source("#46", &rest);
    let parts = appearances(&source, &product_plan(&source, 14, false), 14, IfcType::IfcWall, WALL_GREY);
    assert_eq!(parts.len(), 2);
    near(parts[0].rgba, [0.25, 0.75, 0.25, 1.]);
    near(parts[1].rgba, [0.75, 0.75, 0.25, 1.]);
    assert_eq!((parts[0].geometry_item_id, parts[1].geometry_item_id), (Some(10), Some(11)));
}
