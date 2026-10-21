// SPDX-License-Identifier: MPL-2.0
//! Owned model snapshots through actual canonical geometry and presentation:
//! caller owner drop, revision vs explicit source invalidation, thread
//! transfer, nested reentry and same-context maps/textures.
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::sync::Arc;

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
ENDSEC;END-ISO-10303-21;";

fn router(source: &str, decoder: &mut EntityDecoder) -> GeometryRouter {
    let mut router = GeometryRouter::with_units(source, decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.);
    router.set_rtc_offset((8., 16., 0.));
    router
}
fn options() -> MeshProductionOptions {
    MeshProductionOptions {
        geometry_hash: Some(GeometryHashConfig {
            tolerance: 1e-5,
            world_rtc: [8., 16., 0.],
        }),
    }
}
fn metadata(id: u32) -> ElementMeshMetadata {
    ElementMeshMetadata {
        name: Some(format!("product {id}")),
        ..Default::default()
    }
}
fn job<'a>(entity: &'a DecodedEntity, metadata: &'a ElementMeshMetadata) -> ElementMeshJob<'a> {
    ElementMeshJob {
        id: entity.id,
        ifc_type: entity.ifc_type.clone(),
        entity,
        kind: ElementJobKind::Product,
        element_color: Some([0.1, 0.4, 0.8, 1.]),
        metadata: Some(metadata),
    }
}
/// The borrowed entry over the same source and maps: the owned driver's oracle.
fn borrowed(source: &str, id: u32, data: &OwnedMeshProductionData) -> ProducedElementMeshes {
    let mut decoder = EntityDecoder::new(source);
    let router = router(source, &mut decoder);
    let entity = decoder.decode_by_id(id).unwrap();
    let ctx = MeshProductionContext {
        void_index: &data.void_index,
        geometry_style_index: &data.geometry_style_index,
        indexed_colour_full: &data.indexed_colour_full,
        element_material_colors: &data.element_material_colors,
        texture_index: &data.texture_index,
        site_local_rotation: None,
    };
    produce_element_meshes(
        &job(&entity, &metadata(id)),
        &ctx,
        &options(),
        &mut decoder,
        &router,
    )
}
fn owned(source: &str, id: u32, context: &OwnedMeshProductionContext) -> ProducedElementMeshes {
    let mut decoder = EntityDecoder::new(source);
    let router = router(source, &mut decoder);
    let entity = decoder.decode_by_id(id).unwrap();
    produce_element_meshes_owned(
        &job(&entity, &metadata(id)),
        context,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap()
}
fn assert_same(actual: &ProducedElementMeshes, expected: &ProducedElementMeshes) {
    assert!(
        !actual.meshes.is_empty(),
        "fixture must produce real geometry"
    );
    assert_eq!(actual.meshes.len(), expected.meshes.len());
    for (actual, expected) in actual.meshes.iter().zip(&expected.meshes) {
        assert_eq!(actual.positions, expected.positions);
        assert_eq!(actual.normals, expected.normals);
        assert_eq!(actual.indices, expected.indices);
        assert_eq!(actual.origin, expected.origin);
        assert_eq!(actual.express_id, expected.express_id);
        assert_eq!(actual.geometry_item_id, expected.geometry_item_id);
        assert_eq!(actual.color, expected.color);
        assert_eq!(actual.name, expected.name);
        assert_eq!(actual.uvs, expected.uvs);
        assert_eq!(
            actual.texture.as_ref().map(|t| &t.url),
            expected.texture.as_ref().map(|t| &t.url)
        );
    }
    assert_eq!(actual.geometry_hash, expected.geometry_hash);
    assert_eq!(actual.geometry_aabb, expected.geometry_aabb);
    assert_eq!(actual.geometry_volume, expected.geometry_volume);
    assert_eq!(actual.geometry_closure, expected.geometry_closure);
    assert_eq!(actual.csg_failures, expected.csg_failures);
}
fn styled(color: [f32; 4]) -> OwnedMeshProductionData {
    OwnedMeshProductionData {
        geometry_style_index: Arc::new(
            [(13, GeometryStyleInfo::from_color(color))]
                .into_iter()
                .collect(),
        ),
        ..Default::default()
    }
}

#[test]
fn style_snapshot_survives_caller_drop_mutation_new_revision_and_thread_transfer() {
    let model = ProductionModel::new();
    let (red, green) = ([0.9, 0.1, 0.2, 1.], [0.1, 0.8, 0.2, 1.]);
    let mut data = styled(red);
    let expected = borrowed(SOURCE, 10, &data);
    let styles = Arc::downgrade(&data.geometry_style_index);
    let context = model.snapshot(data.clone());
    let before = styles.strong_count();
    let actual = owned(SOURCE, 10, &context);
    assert_eq!(
        styles.strong_count(),
        before,
        "a product never clones a map Arc"
    );
    assert_same(&actual, &expected);
    Arc::make_mut(&mut data.geometry_style_index).insert(13, GeometryStyleInfo::from_color(green));
    let newer = model.snapshot(data);
    assert_ne!(context.id(), newer.id());
    assert!(
        context.validate_source().is_ok(),
        "a new same-source revision does not expire old work"
    );
    drop(model);
    let moved = std::thread::spawn(move || owned(SOURCE, 10, &context))
        .join()
        .unwrap();
    assert_eq!(
        moved.meshes[0].color, red,
        "the snapshot retains the actual original map"
    );
    assert_same(&moved, &expected);
    let changed = owned(SOURCE, 10, &newer);
    assert_eq!(changed.meshes[0].color, green);
    assert_eq!(
        moved.geometry_hash, changed.geometry_hash,
        "appearance never alters geometry"
    );
    assert_eq!(moved.meshes[0].positions, changed.meshes[0].positions);
}

#[test]
fn explicit_invalidation_refuses_every_earlier_snapshot_before_work() {
    let model = ProductionModel::new();
    let (a, b) = (
        model.snapshot(styled([1., 0., 0., 1.])),
        model.snapshot(Default::default()),
    );
    model.invalidate_source();
    for stale in [&a, &b] {
        assert_eq!(
            stale.validate_source(),
            Err(ProductionContextError::StaleSource)
        );
    }
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = router(SOURCE, &mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(Invalidate {
        model: None,
        calls: calls.clone(),
    }));
    let entity = decoder.decode_by_id(10).unwrap();
    let refused = produce_element_meshes_owned(
        &job(&entity, &metadata(10)),
        &a,
        &options(),
        &mut decoder,
        &router,
    );
    assert_eq!(refused.err(), Some(ProductionContextError::StaleSource));
    assert_eq!(calls.get(), 0, "a stale snapshot runs no geometry");
    assert!(decoder.try_execution_lease().is_ok());
    let fresh = model.snapshot(Default::default());
    assert!(model.owns_snapshot(&fresh) && model.owns_snapshot(&a));
    let actual = produce_element_meshes_owned(
        &job(&entity, &metadata(10)),
        &fresh,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap();
    assert_eq!(calls.get(), 1);
    assert_same(&actual, &borrowed(SOURCE, 10, &Default::default()));
}

#[test]
fn independent_loads_of_identical_maps_never_share_completion_identity() {
    let (first, second) = (ProductionModel::new(), ProductionModel::new());
    let data = OwnedMeshProductionData::default();
    let (a, b) = (first.snapshot(data.clone()), second.snapshot(data.clone()));
    assert_ne!(a.id(), b.id());
    assert!(!first.owns_snapshot(&b) && !second.owns_snapshot(&a));
    first.invalidate_source();
    assert_eq!(
        a.validate_source(),
        Err(ProductionContextError::StaleSource)
    );
    assert!(
        b.validate_source().is_ok(),
        "another load's lifecycle is independent"
    );
    assert_same(&owned(SOURCE, 10, &b), &borrowed(SOURCE, 10, &data));
}

/// Counts actual extrusions; optionally invalidates the model on the first.
struct Invalidate {
    model: Option<ProductionModel>,
    calls: Rc<Cell<usize>>,
}
impl GeometryProcessor for Invalidate {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        if let Some(model) = self.model.as_ref().filter(|_| self.calls.get() == 1) {
            model.invalidate_source();
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

#[test]
fn invalidation_inside_actual_geometry_never_publishes_and_a_fresh_snapshot_retries() {
    let model = ProductionModel::new();
    let context = model.snapshot(Default::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = router(SOURCE, &mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(Invalidate {
        model: Some(model.clone()),
        calls: calls.clone(),
    }));
    let entity = decoder.decode_by_id(10).unwrap();
    let refused = produce_element_meshes_owned(
        &job(&entity, &metadata(10)),
        &context,
        &options(),
        &mut decoder,
        &router,
    );
    assert_eq!(refused.err(), Some(ProductionContextError::StaleSource));
    assert_eq!(
        calls.get(),
        1,
        "expiry happened during actual geometry, before publication"
    );
    assert!(decoder.try_execution_lease().is_ok());
    let fresh = model.snapshot(Default::default());
    let actual = produce_element_meshes_owned(
        &job(&entity, &metadata(10)),
        &fresh,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap();
    assert_same(&actual, &borrowed(SOURCE, 10, &Default::default()));
}

/// Runs the slab as a nested product from inside the wall's extrusion.
struct Nested {
    router: Weak<GeometryRouter>,
    context: Arc<OwnedMeshProductionContext>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
}
impl GeometryProcessor for Nested {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        if entity.id == 13 {
            let child = decoder.decode_by_id(20).unwrap();
            let router = self.router.upgrade().unwrap();
            let result = produce_element_meshes_owned(
                &job(&child, &metadata(20)),
                &self.context,
                &options(),
                decoder,
                &router,
            );
            *self.child.borrow_mut() = Some(result.unwrap());
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

#[test]
fn nested_product_reenters_the_driver_with_the_same_snapshot() {
    let model = ProductionModel::new();
    let data = styled([0.3, 0.3, 0.9, 1.]);
    let context = model.snapshot(data.clone());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut geometry_router = router(SOURCE, &mut decoder);
    let child = Rc::new(RefCell::new(None));
    let router = Rc::new_cyclic(|router| {
        geometry_router.register(Box::new(Nested {
            router: router.clone(),
            context: Arc::clone(&context),
            child: child.clone(),
        }));
        geometry_router
    });
    let entity = decoder.decode_by_id(10).unwrap();
    let actual = produce_element_meshes_owned(
        &job(&entity, &metadata(10)),
        &context,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap();
    assert_same(&actual, &borrowed(SOURCE, 10, &data));
    let nested = child
        .borrow_mut()
        .take()
        .expect("the real nested slab completed");
    assert_same(&nested, &borrowed(SOURCE, 20, &data));
    assert!(decoder.try_execution_lease().is_ok());
}

#[test]
fn texture_snapshot_keeps_its_image_and_uv_pairing_after_the_caller_replaces_the_map() {
    let source = SOURCE
        .replace(
            "#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);",
            "#13=IFCTRIANGULATEDFACESET(#16,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);\n\
             #16=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));\n\
             #200=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'assets/original.png');\n\
             #201=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(1.,1.)));\n\
             #202=IFCINDEXEDTRIANGLETEXTUREMAP((#200),#13,#201,$);",
        )
        .replace(
            "#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));",
            "#12=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#13));",
        );
    let mut decoder = EntityDecoder::new(&source);
    let model = ProductionModel::new();
    let mut data = OwnedMeshProductionData {
        texture_index: Arc::new(ifc_lite_geometry::build_texture_index(
            source.as_bytes(),
            &mut decoder,
        )),
        ..Default::default()
    };
    assert_eq!(
        data.texture_index.len(),
        1,
        "resolve the actual IFC indexed texture"
    );
    let expected = borrowed(&source, 10, &data);
    let context = model.snapshot(data.clone());
    let map = Arc::make_mut(&mut data.texture_index).get_mut(&13).unwrap();
    map.texture = ifc_lite_geometry::TextureSource::Image(ifc_lite_geometry::ImageTextureRef {
        url: "assets/replacement.png".into(),
        repeat_s: false,
        repeat_t: true,
    });
    let replacement = model.snapshot(data);
    drop(model);
    let actual = owned(&source, 10, &context);
    assert_same(&actual, &expected);
    let texture = actual.meshes[0]
        .texture
        .as_ref()
        .expect("the owned map still attaches its texture");
    assert_eq!(texture.url.as_deref(), Some("assets/original.png"));
    assert_eq!(
        (texture.repeat_s, texture.repeat_t, texture.texture_id),
        (true, false, 200)
    );
    let changed = owned(&source, 10, &replacement);
    assert_eq!(
        changed.meshes[0].texture.as_ref().unwrap().url.as_deref(),
        Some("assets/replacement.png")
    );
    assert_eq!(actual.meshes[0].positions, changed.meshes[0].positions);
    assert_eq!(
        actual.meshes[0].uvs, changed.meshes[0].uvs,
        "same UVs, only the image changed"
    );
}

#[test]
fn owned_opening_index_still_cuts_real_geometry_after_the_caller_drops_it() {
    let source = SOURCE.replace(
        "#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);",
        "#20=IFCOPENINGELEMENT('s',$,'Cut',$,$,#9,#21,$,.OPENING.);",
    );
    let data = OwnedMeshProductionData {
        void_index: Arc::new([(10, vec![20])].into_iter().collect()),
        ..Default::default()
    };
    let expected = borrowed(&source, 10, &data);
    let model = ProductionModel::new();
    let context = model.snapshot(data);
    drop(model);
    let actual = owned(&source, 10, &context);
    assert_same(&actual, &expected);
    assert!(
        (actual.geometry_volume.unwrap() - 20.).abs() < 1e-5,
        "24 minus the real 2x4x0.5 opening"
    );
}
