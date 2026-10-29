// SPDX-License-Identifier: MPL-2.0
//! M11-A internals, SMLib-free: the seams the kernel-free witness in `tests/m11_a_appearance.rs` cannot reach
//! (pending bindings, material bands, part-count and cursor sharing).
use super::super::appearance_resolve::{bind, resolve_parts, PartSource};
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
    ShapePart { positions: Vec::new(), indices: Vec::new(), world_from_object: [0.; 16], curved: false,
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
fn resolve(parts: &[(PartSource, PresentationFacts)]) -> Result<Vec<PartAppearance>, RetainedExecutionError> {
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
    assert_unsupported(resolve(&[(PartSource::Item(7), texture)]).unwrap_err(), 7, "texture_pending");
    let mut palette = fact(8);
    palette.indexed_palette_pending = true;
    assert_unsupported(resolve(&[(PartSource::Item(7), fact(7)), (PartSource::Item(8), palette)]).unwrap_err(), 8, "indexed_palette_pending");
}
#[test]
fn m11_a_band_parts_keyed_by_material_refuse_until_layers_land() {
    assert_unsupported(resolve(&[(PartSource::Material(31), fact(31))]).unwrap_err(), 31, "material_band");
}
#[test]
fn m11_a_a_part_count_that_differs_from_the_plan_refuses() {
    let source = source("#10", WALL);
    let plan = product_plan(&source, 14);
    let mut product = ShapeOnlyProduct { cuts: 0, consumed_parts: 0, cut_times_ms: Vec::new(), product_id: 14,
        ifc_type: IfcType::IfcWall, parts: vec![hand_part(), hand_part()],
        obligations: PresentationObligationsUnmet(vec![Requirement::IfcAppearance]), _storage: Storage::default() };
    let model = snapshot(&source);
    let error = apply(&mut product, &Context { plan: &plan, model: &model, resources: &OwnedResourceContext::capture_current(),
        element_color: [0.; 4], faces: &[], chord_metres: 0.001 }).unwrap_err();
    assert_unsupported(error, 0, "binding");
}
#[test]
fn m11_a_binding_selection_prefers_the_type_binding_and_keeps_every_pending_flag() {
    let mut item = fact(7);
    item.texture_pending = true;
    let typed = PresentationFacts { type_product: Some((60, 1)), representation_map: Some(61), ..fact(60) };
    let (source, chosen) = bind(&[item, typed]);
    assert_eq!((source, chosen.type_product, chosen.texture_pending), (PartSource::Item(60), Some((60, 1)), true));
    assert_unsupported(resolve(&[(source, chosen)]).unwrap_err(), 60, "texture_pending");
    assert_eq!(bind(&[]).0, PartSource::Unbound);
    // Inner item first, enclosing occurrence last: the outermost decides, as exact keys a mapped result.
    assert_eq!(bind(&[fact(1), fact(2)]).0, PartSource::Item(2));
}
#[test]
fn m11_a_frames_of_one_item_are_one_sub_mesh_and_advance_the_material_cursor_once() {
    let source = window();
    let model = snapshot(&source);
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(14).unwrap();
    let job = ElementMeshJob { id: 14, ifc_type: IfcType::IfcWindow, entity: &entity, kind: ElementJobKind::Product,
        element_color: None, metadata: None };
    let parts = [(PartSource::Item(10), fact(10)), (PartSource::Item(10), fact(10)), (PartSource::Item(11), fact(11))];
    let resolved = resolve_parts(&AssemblyJob::from(&job), &parts, [0.6, 0.8, 1.0, 0.4], &model.borrowed(), &mut decoder).unwrap();
    near(resolved[0].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(resolved[1].rgba, [0.6, 0.8, 1.0, 0.35]);
    near(resolved[2].rgba, [0.3, 0.2, 0.1, 1.]);
}
