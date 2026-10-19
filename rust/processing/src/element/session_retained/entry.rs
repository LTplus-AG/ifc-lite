// SPDX-License-Identifier: MPL-2.0
//! Authenticate the actual product root inside the same reserved source owner.
use super::super::session_owner::ProductOwner;
use super::*;
impl RetainedProductExecution {
    pub fn new(
        job: &ElementMeshJob<'_>,
        context: &Arc<OwnedMeshProductionContext>,
        options: &MeshProductionOptions,
        decoder: &mut EntityDecoder<'_>,
        router: &GeometryRouter,
    ) -> Result<Self, RetainedExecutionError> {
        if context.source().is_none() { return Err(RetainedExecutionError::Source) }
        context.validate_decoder(decoder).map_err(|_| RetainedExecutionError::Source)?;
        super::super::session_canonical::with_source_resources(decoder, |decoder|
            Self::new_authenticated(job, context, options, decoder, router))
    }
    fn new_authenticated(job: &ElementMeshJob<'_>, context: &Arc<OwnedMeshProductionContext>,
        options: &MeshProductionOptions, decoder: &mut EntityDecoder<'_>, router: &GeometryRouter)
        -> Result<Self, RetainedExecutionError> {
        if context.source().is_none() {
            return Err(RetainedExecutionError::Source);
        }
        context
            .validate_decoder(decoder)
            .map_err(|_| RetainedExecutionError::Source)?;
        let mut owner = ProductOwner::admit(decoder, router).map_err(protocol)?;
        // A fresh trusted work epoch must not erase a Compatibility-domain
        // terminal established before this retained owner was constructed.
        ifc_lite_geometry::resource::check_current().map_err(RetainedExecutionError::Stopped)?;
        let (captured, _) = owner.work(decoder, router, |decoder, _| {
            let resources = OwnedResourceContext::capture_current();
            resources.check().map_err(RetainedExecutionError::Stopped)?;
            ifc_lite_geometry::resource::charge(ifc_lite_geometry::resource::Cost {
                work: 1, ..Default::default()
            }).map_err(RetainedExecutionError::Stopped)?;
            let actual = decoder.decode_by_id(job.id).map_err(|_| RetainedExecutionError::Source)?;
            Ok::<_, RetainedExecutionError>((actual, resources))
        }).map_err(protocol)?;
        let (actual, resources) = captured?;
        if job.entity.id != actual.id || job.ifc_type != actual.ifc_type {
            return Err(RetainedExecutionError::Source);
        }
        let canonical_job = ElementMeshJob {
            id: actual.id,
            ifc_type: actual.ifc_type.clone(),
            entity: &actual,
            kind: job.kind.clone(),
            element_color: job.element_color,
            metadata: job.metadata,
        };
        let (source_epoch, source_revision) = context.lifecycle().epoch_revision();
        let mut state = resources.with_scope(|| ProductState::new_with_owner(
            &canonical_job,
            &context.borrowed(),
            options,
            decoder,
            router,
            Some(owner),
        ));
        resources.check().map_err(RetainedExecutionError::Stopped)?;
        context
            .validate_decoder(decoder)
            .map_err(|_| RetainedExecutionError::Source)?;
        state.bind_context(context.id());
        state.presentation_context = Some(context.clone());
        state.retained_contract = Some(RetainedContract {
            source_epoch,
            source_revision,
        });
        Ok(Self {
            state,
            context: context.clone(),
            pending: None,
            ledger: Vec::default(),
            plan: None,
            type_values:Vec::default(),
            failed: false,
            resources,
        })
    }
}
