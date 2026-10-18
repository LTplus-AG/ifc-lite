// SPDX-License-Identifier: MPL-2.0
//! Actual source binding through canonical product work and reply admission.
use super::owned_session::OwnedProductExecution;
use super::session_protocol::WorkError;
use super::session_tests::{assert_same, canonical, job, metadata, options, router, SOURCE};
use super::*;
use ifc_lite_core::SourceBundle;
use std::sync::Arc;

#[test]
fn bundle_snapshot_retains_actual_source_after_caller_drop_and_dormant_worker_transfer() {
    let bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(bundle.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let session = {
        let mut decoder = bundle.decoder();
        let router = router(&mut decoder);
        let entity = decoder.decode_by_id(50).unwrap();
        OwnedProductExecution::new(
            &job(&entity, &metadata(50)),
            &context,
            &options(),
            &mut decoder,
            &router,
        )
        .unwrap()
    };
    drop(model);
    drop(bundle);
    let result = std::thread::spawn(move || {
        let source = context.source().unwrap();
        let mut decoder = source.decoder();
        let router = router(&mut decoder);
        let mut session = session;
        while session.advance(&mut decoder, &router).unwrap() {}
        session.finish(&decoder, &router).unwrap()
    })
    .join()
    .unwrap();
    assert_same(&result, &canonical(50, false));
}

#[test]
fn same_sized_foreign_source_is_rejected_before_owner_effects_and_real_reply_admission() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let foreign = SourceBundle::new(SOURCE.replace("IFCWALL", "IFCBEAM").into_bytes());
    assert_eq!(source.bytes().len(), foreign.bytes().len());
    let context =
        ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut other = foreign.decoder();
    assert_eq!(
        produce_element_meshes_owned(
            &job(&entity, &metadata(10)),
            &context,
            &options(),
            &mut other,
            &router
        )
        .err(),
        Some(ProductionContextError::MismatchedSource)
    );
    assert!(other.try_execution_lease().is_ok());
    let mut session = OwnedProductExecution::new(
        &job(&entity, &metadata(10)),
        &context,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap();
    let request = session.request().unwrap().unwrap();
    assert_eq!(
        session.execute(request, &mut other, &router).err(),
        Some(WorkError::MismatchedSource)
    );
    let reply = session.execute(request, &mut decoder, &router).unwrap();
    let rejected = session.accept(reply, &mut other, &router).unwrap_err();
    assert_eq!(rejected.error, WorkError::MismatchedSource);
    assert!(session.state.meshes.is_empty());
    session
        .accept(rejected.reply, &mut decoder, &router)
        .unwrap();
    while session.advance(&mut decoder, &router).unwrap() {}
    assert_same(
        &session.finish(&decoder, &router).unwrap(),
        &canonical(10, false),
    );
}

#[test]
fn immutable_configuration_revisions_keep_same_source_valid_until_explicit_expiry() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let red = [0.8, 0.1, 0.2, 1.];
    let green = [0.2, 0.8, 0.1, 1.];
    let snapshot = |color| {
        model.snapshot(OwnedMeshProductionData {
            geometry_style_index: Arc::new(
                [(13, GeometryStyleInfo::from_color(color))]
                    .into_iter()
                    .collect(),
            ),
            ..Default::default()
        })
    };
    let a = snapshot(red);
    let b = snapshot(green);
    for (context, color) in [(&a, red), (&b, green), (&a, red)] {
        let mut decoder = source.decoder();
        let router = router(&mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let actual = produce_element_meshes_owned(
            &job(&entity, &metadata(10)),
            context,
            &options(),
            &mut decoder,
            &router,
        )
        .unwrap();
        assert_eq!(actual.meshes[0].color, color);
        assert!((actual.geometry_volume.unwrap() - 24.).abs() < 1e-5);
    }
    model.invalidate_source();
    assert_eq!(
        a.validate_source(),
        Err(ProductionContextError::StaleSource)
    );
    assert_eq!(
        b.validate_source(),
        Err(ProductionContextError::StaleSource)
    );
}

struct ScopedChild {
    context: Arc<OwnedMeshProductionContext>,
    child: Arc<std::sync::Mutex<Option<ProducedElementMeshes>>>,
}
impl ifc_lite_geometry::GeometryProcessor for ScopedChild {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &ifc_lite_core::IfcSchema,
        quality: ifc_lite_geometry::TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        if entity.id == 13 {
            let context = &self.context;
            let parent = std::thread::current().id();
            let child = std::thread::scope(|scope| {
                let decoder = &mut *decoder;
                scope
                    .spawn(move || {
                        assert_ne!(parent, std::thread::current().id());
                        let child_router = router(decoder);
                        let entity = decoder.decode_by_id(20).unwrap();
                        let output = produce_element_meshes_owned(
                            &job(&entity, &metadata(20)),
                            context,
                            &options(),
                            decoder,
                            &child_router,
                        )
                        .unwrap();
                        assert!(
                            decoder.try_execution_lease().is_err(),
                            "scoped child cannot release parent decoder"
                        );
                        output
                    })
                    .join()
                    .unwrap()
            });
            *self.child.lock().unwrap() = Some(child);
        }
        ifc_lite_geometry::ExtrudedAreaSolidProcessor::new(schema.clone())
            .process(entity, decoder, schema, quality)
    }
}
#[test]
fn bound_source_preserves_scoped_mutable_decoder_and_nested_canonical_child() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut decoder = source.decoder();
    let mut router = router(&mut decoder);
    let child = Arc::new(std::sync::Mutex::new(None));
    router.register(Box::new(ScopedChild {
        context: context.clone(),
        child: child.clone(),
    }));
    let entity = decoder.decode_by_id(10).unwrap();
    let output = produce_element_meshes_owned(
        &job(&entity, &metadata(10)),
        &context,
        &options(),
        &mut decoder,
        &router,
    )
    .unwrap();
    assert_same(&output, &canonical(10, false));
    assert_same(
        &child.lock().unwrap().take().unwrap(),
        &canonical(20, false),
    );
    assert!(decoder.try_execution_lease().is_ok());
}

#[test]
fn raw_semantic_imports_are_rejected_before_work_but_explicit_authored_revision_is_scoped() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let foreign_bytes = SOURCE.replace("IFCWALL", "IFCBEAM").into_bytes();
    let mut foreign = EntityDecoder::new(&foreign_bytes);
    foreign.decode_by_id(10).unwrap();
    decoder.inject_shared_cache(&foreign.drain_cache());
    assert_eq!(produce_element_meshes_owned(&job(&entity, &metadata(10)), &context,
        &options(), &mut decoder, &router).err(), Some(ProductionContextError::MismatchedSource));
    assert!(decoder.try_execution_lease().is_ok());
    // Authoring explicitly trusts a particular current input revision; this
    // neither restores pure-source authority nor accepts a later raw import.
    let authored = ProductionModel::from_trusted_inputs(decoder.trusted_inputs().unwrap())
        .snapshot(OwnedMeshProductionData::default());
    assert!(authored.validate_decoder(&decoder).is_ok());
    assert!(!source.owns_decoder(&decoder));
    decoder.set_point_cache(Default::default());
    assert_eq!(authored.validate_decoder(&decoder), Err(ProductionContextError::MismatchedSource));
}
