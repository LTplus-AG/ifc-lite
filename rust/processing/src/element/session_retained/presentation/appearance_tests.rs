// SPDX-License-Identifier: MPL-2.0
//! M11-A internals, SMLib-free: the seams the kernel-free witness in `tests/m11_a_appearance.rs` cannot reach
//! (pending bindings, material bands, part-count and cursor sharing).
use super::super::appearance_resolve::{bind, resolve_parts, Bound, PartSource};
use super::{apply, Context, Requirement};
use crate::element::assembly_job::AssemblyJob;
use crate::element::session_retained::error::RetainedExecutionError;
use crate::element::session_retained::publication::{PartAppearance, PresentationObligationsUnmet, ShapeOnlyProduct, ShapePart};
use crate::element::session_retained::{OwnedResourceContext, RetainedProductPlan, Storage};
use crate::element::{ElementJobKind, ElementMeshJob, OwnedMeshProductionData, ProductionModel};
use crate::prepass::{resolve_prepass, PrepassSpans};
use ifc_lite_core::{EntityScanner, IfcType, SourceBundle};
use ifc_lite_geometry::program::transactions::{PresentationFacts, Traversal};
use ifc_lite_geometry::GeometryRouter;
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
/// One RGB style: colour `#c`, transparency `t`, applied as `#id` (a surface style).
fn style(id: u32, rgb: [f64; 3], transparency: f64) -> String {
    format!("#{c}=IFCCOLOURRGB($,{:?},{:?},{:?});#{r}=IFCSURFACESTYLERENDERING(#{c},{transparency:?},$,$,$,$,$,$,.NOTDEFINED.);\
        #{id}=IFCSURFACESTYLE($,.BOTH.,(#{r}));", rgb[0], rgb[1], rgb[2], c = id + 1, r = id + 2)
}
/// A source whose body representation #12 holds `items`; `rest` adds the product and its styling.
fn source(items: &str, rest: &str) -> Arc<SourceBundle> {
    SourceBundle::new(format!("{HEAD}#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',({items}));\
        #13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));{rest}ENDSEC;END-ISO-10303-21;").into_bytes())
}
fn snapshot(source: &Arc<SourceBundle>) -> Arc<crate::element::OwnedMeshProductionContext> {
    let mut decoder = source.decoder();
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(source.bytes());
    while let Some((id, name, start, end)) = scanner.next_entity() {
        spans.stash(name, id, start, end);
    }
    let resolved = resolve_prepass(&spans, &mut decoder, Default::default());
    ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        geometry_style_index: Arc::new(resolved.geometry_style_index),
        indexed_colour_full: Arc::new(resolved.indexed_colour_full),
        element_material_colors: Arc::new(resolved.element_material_colors),
        ..Default::default()
    })
}
fn walk(program: &mut ifc_lite_geometry::program::transactions::Program<'_>, router: &GeometryRouter,
        decoder: &mut ifc_lite_core::EntityDecoder) {
    while let Some(ticket) = program.request().unwrap() {
        let (reply, _, _storage) = program.admit(ticket, router, decoder).unwrap();
        program.accept(reply, router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
}
fn product_plan(source: &Arc<SourceBundle>, id: u32) -> RetainedProductPlan {
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(source.bytes(), &mut decoder);
    let entity = decoder.decode_by_id(id).unwrap();
    let textures = Default::default();
    let mut program = Traversal::new(1, 1).product_submeshes(&entity, &textures);
    walk(&mut program, &router, &mut decoder);
    program.finish().unwrap()
}
fn hand_part() -> ShapePart {
    ShapePart { layer: None, capped_volume_m3: None, positions: Vec::new(), indices: Vec::new(), world_from_object: [0.; 16], curved: false, halfspace_clipped: false,
        revision_local_faces: Vec::new(), normals: None, appearance: None, faces: None, instance_key: None }
}
const WALL: &str = "#14=IFCWALL('w',$,'Wall',$,$,#7,#13,$,$);";
/// Two unstyled items, materials [glass(alpha .35), frame(opaque)].
fn window() -> Arc<SourceBundle> {
    let rest = format!("#14=IFCWINDOW('w',$,'Win',$,$,#7,#13,$,1.,1.,$,$,$);\
        #15=IFCMATERIAL('Glass');#16=IFCMATERIAL('Frame');#17=IFCMATERIALLIST((#15,#16));\
        #18=IFCRELASSOCIATESMATERIAL('r',$,$,$,(#14),#17);\
        #30=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#31),#15);#31=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#32));\
        #32=IFCSTYLEDITEM($,(#33),$);{}\
        #50=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#51),#16);#51=IFCSTYLEDREPRESENTATION(#2,'S','Material',(#52));\
        #52=IFCSTYLEDITEM($,(#53),$);{}", style(33, [0.6, 0.8, 1.0], 0.65), style(53, [0.3, 0.2, 0.1], 0.));
    source("#10,#11", &rest)
}
fn near(actual: [f32; 4], expected: [f32; 4]) {
    assert!(actual.iter().zip(expected).all(|(a, e)| (a - e).abs() < 1e-6), "{actual:?} != {expected:?}");
}
fn fact(geometry_id: u32) -> PresentationFacts {
    PresentationFacts { geometry_id, style_source_id: geometry_id, representation_map: None, type_product: None,
        fallback_color: None, indexed_palette_pending: false, texture_pending: false }
}
/// An `IfcMappedItem` occurrence's binding: the map item decides nothing, it only encloses.
fn occurrence(item: u32, map: u32) -> PresentationFacts {
    PresentationFacts { geometry_id: item, style_source_id: item, representation_map: Some(map), ..fact(item) }
}
fn bound(fact: PresentationFacts) -> Bound {
    Bound { source: PartSource::Item(fact.geometry_id), fact, occurrences: Vec::new() }
}
fn under(fact: PresentationFacts, occurrences: &[u32]) -> Bound {
    Bound { occurrences: occurrences.to_vec(), ..bound(fact) }
}
fn resolve(parts: &[Bound]) -> Result<Vec<PartAppearance>, RetainedExecutionError> {
    let source = source("#10", WALL);
    let model = snapshot(&source);
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(14).unwrap();
    let job = ElementMeshJob { id: 14, ifc_type: IfcType::IfcWall, entity: &entity, kind: ElementJobKind::Product,
        element_color: None, metadata: None };
    resolve_parts(&AssemblyJob::from(&job), parts, [0.85, 0.85, 0.85, 1.], &model.borrowed(), &mut decoder)
}
fn assert_unsupported(error: RetainedExecutionError, entity: u32, cause: &str) {
    let (refusal, origin) = error.refusal();
    assert_eq!(refusal.code(), "appearance_unsupported");
    let origin = origin.expect("typed origin");
    assert_eq!((origin.site, origin.entity, origin.cause), ("appearance", Some(entity), cause));
}
#[test]
fn m11_a_textures_and_indexed_palettes_refuse_as_explicit_absence() {
    // Both arise only on IfcTessellatedFaceSet, which retained refuses upstream (census: 0/131
    // committed, 0/94,567 heavy-eligible). A binding that still carries one never gets plain colour.
    let mut texture = fact(7);
    texture.texture_pending = true;
    assert_unsupported(resolve(&[bound(texture)]).unwrap_err(), 7, "texture_pending");
    let mut palette = fact(8);
    palette.indexed_palette_pending = true;
    assert_unsupported(resolve(&[bound(fact(7)), bound(palette)]).unwrap_err(), 8, "indexed_palette_pending");
}
#[test]
fn m4_band_without_a_material_style_uses_exact_fallback_and_material_identity() {
    let band = Bound { source: PartSource::Material(31), ..bound(fact(31)) };
    let parts = resolve(&[band]).unwrap();
    near(parts[0].rgba, [0.85, 0.85, 0.85, 1.]);
    assert_eq!(parts[0].geometry_item_id, None);
    assert_eq!(parts[0].material_id, Some(31));
    assert_eq!(parts[0].material_name, None);
}
#[test]
fn m11_a_a_part_count_that_differs_from_the_plan_refuses() {
    let source = source("#10", WALL);
    let plan = product_plan(&source, 14);
    let mut product = ShapeOnlyProduct { band_ms: 0., cap_ms: 0., max_snap_metres: 0., cuts: 0, consumed_parts: 0, cut_times_ms: Vec::new(), normal_planar_fallbacks: 0, product_id: 14,
        ifc_type: IfcType::IfcWall, parts: vec![hand_part(), hand_part()],
        obligations: PresentationObligationsUnmet(vec![Requirement::IfcAppearance]), _storage: Storage::default() };
    let model = snapshot(&source);
    let error = apply(&mut product, &Context { layer_class: 0, plan: &plan, model: &model, resources: &OwnedResourceContext::capture_current(),
        element_color: [0.; 4], faces: &[], chord_metres: 0.001, angle_degrees: 5. }).unwrap_err();
    assert_unsupported(error, 14, "binding");
}
#[test]
fn m11_a_binding_selection_prefers_the_type_binding_and_keeps_every_pending_flag() {
    let mut item = fact(7);
    item.texture_pending = true;
    let typed = PresentationFacts { type_product: Some((60, 1)), representation_map: Some(61), ..fact(60) };
    let Bound { source, fact: chosen, .. } = bind(&[item, typed]).unwrap();
    assert_eq!((source, chosen.type_product, chosen.texture_pending), (PartSource::Item(60), Some((60, 1)), true));
    assert_unsupported(resolve(&[Bound { source, fact: chosen, occurrences: Vec::new() }]).unwrap_err(), 60, "texture_pending");
    assert_eq!(bind(&[]).unwrap().source, PartSource::Unbound);
}
#[test]
fn m11_a_the_walk_item_decides_never_the_enclosing_occurrence() {
    // The walk appends the leaf's binding, then each enclosing IfcMappedItem's, inner to outer. Exact keys the
    // sub-mesh by the leaf (`Merging::Styled(item.item().id, ..)`), so every occurrence is skipped.
    let mapped = bind(&[fact(1), occurrence(2, 90)]).unwrap();
    assert_eq!((mapped.source, mapped.fact.geometry_id, mapped.occurrences), (PartSource::Item(1), 1, vec![2]));
    let nested = bind(&[fact(1), occurrence(2, 90), occurrence(3, 91)]).unwrap();
    assert_eq!((nested.source, nested.occurrences), (PartSource::Item(1), vec![2, 3]));
    // A Boolean result's own binding follows its host's: the result's item is the sub-mesh identity.
    assert_eq!(bind(&[fact(1), fact(2)]).unwrap().source, PartSource::Item(2));
    assert_eq!(bind(&[fact(1), fact(2), occurrence(3, 90)]).unwrap().source, PartSource::Item(2));
    // Only occurrences: no sub-mesh identity to match exact with, so it refuses rather than keys by the map.
    assert_unsupported(bind(&[occurrence(2, 90)]).err().expect("refuses"), 2, "binding");
}
#[test]
fn m11_a_frames_of_one_item_are_one_sub_mesh_and_advance_the_material_cursor_once() {
    let source = window();
    let model = snapshot(&source);
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(14).unwrap();
    let job = ElementMeshJob { id: 14, ifc_type: IfcType::IfcWindow, entity: &entity, kind: ElementJobKind::Product,
        element_color: None, metadata: None };
    let parts = [bound(fact(10)), bound(fact(10)), bound(fact(11))];
    let resolved = resolve_parts(&AssemblyJob::from(&job), &parts, [0.6, 0.8, 1.0, 0.4], &model.borrowed(), &mut decoder).unwrap();
    near(resolved[0].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(resolved[1].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(resolved[2].rgba, [0.3, 0.2, 0.1, 1.]);
}
#[test]
fn m11_a_one_leaf_under_two_occurrences_is_two_sub_meshes_and_two_cursor_steps() {
    let source = window();
    let model = snapshot(&source);
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(14).unwrap();
    let job = ElementMeshJob { id: 14, ifc_type: IfcType::IfcWindow, entity: &entity, kind: ElementJobKind::Product,
        element_color: None, metadata: None };
    // Exact calls `color` once per sub-mesh: the same leaf walked under two map items is two (glass, then frame).
    // Two frames under one chain are one. Chains that differ only in an inner occurrence still differ.
    let parts = [under(fact(10), &[20]), under(fact(10), &[20]), under(fact(10), &[21]), under(fact(10), &[22, 30]),
        under(fact(10), &[23, 30])];
    let resolved = resolve_parts(&AssemblyJob::from(&job), &parts, [0.6, 0.8, 1.0, 0.4], &model.borrowed(), &mut decoder).unwrap();
    let alphas: Vec<f32> = resolved.iter().map(|part| part.rgba[3]).collect();
    // The cursor alternates over [glass .35, frame 1.]: the two frames of #20 share the first step.
    near([alphas[0], alphas[1], alphas[2], alphas[3]], [0.35, 0.35, 1., 0.35]);
    near([alphas[4], 0., 0., 0.], [1., 0., 0., 0.]);
    assert!(resolved.iter().all(|part| part.geometry_item_id == Some(10)));
}
