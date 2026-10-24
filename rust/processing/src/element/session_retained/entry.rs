// SPDX-License-Identifier: MPL-2.0
use super::*;
impl<'a, R: NumericalReceipt> RuntimeProductExecution<'a, R> {
    pub fn begin(
        job: &'a ElementMeshJob<'a>,
        context: &'a OwnedMeshProductionContext,
        options: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<Self, RetainedExecutionError> {
        if context.source().is_none() {
            return Err(RetainedExecutionError::Source);
        }
        context
            .validate_decoder(decoder)
            .map_err(|_| RetainedExecutionError::Source)?;
        super::super::session_canonical::with_source_resources(decoder, |decoder| {
            resource::check_current().map_err(RetainedExecutionError::Stopped)?;
            let mut owner = ProductOwner::admit(decoder, router).map_err(protocol)?;
            let mut scopes = Scopes::new();
            let ((resources, planned, terminal, layer_source), _) = owner
                .work(decoder, router, |d, r| {
                    let resources = OwnedResourceContext::capture_current();
                    resources.check().map_err(RetainedExecutionError::Stopped)?;
                    resource::charge(resource::Cost {
                        work: 1,
                        ..Default::default()
                    })
                    .map_err(RetainedExecutionError::Stopped)?
                    .retain();
                    let actual = d
                        .decode_by_id(job.id)
                        .map_err(|_| RetainedExecutionError::Source)?;
                    if actual.id != job.entity.id
                        || actual.ifc_type != job.ifc_type
                        || actual.ifc_type != job.entity.ifc_type
                        || !Arc::ptr_eq(&actual.attributes, &job.entity.attributes)
                    {
                        return Err(RetainedExecutionError::Source);
                    }
                    let (planned, terminal) = scopes
                        .with_scope(|| plan_in_scope(job, &context.borrowed(), options, d, r));
                    let layer_source = layers::capture(context, &actual, d, r)?;
                    Ok::<_, RetainedExecutionError>((resources, planned, terminal, layer_source))
                })
                .map_err(protocol)
                .and_then(|(result, stamp)| result.map(|result| (result, stamp)))?;
            resources.check().map_err(RetainedExecutionError::Stopped)?;
            let state = ProductState::planned(job, planned, terminal, Some(context.id()), None);
            if let Some(stop) = state.terminal() {
                return Err(RetainedExecutionError::Stopped(stop));
            }
            let layer_pending = matches!(state.stage, Stage::Primary { layer_class, .. } if layer_class != 0);
            let (source_epoch, source_revision) = context.lifecycle().epoch_revision();
            let traversal = RetainedTraversal::new(RetainedContract { source_epoch,source_revision });
            let mut execution = Self {
                state,
                context,
                owner,
                scopes,
                resources,
                program: None,
                outer: None,
                traversal,
                type_values: Vec::new(),
                type_map_members: Default::default(),
                layer_pending: layer_pending || layer_source.is_some(),
                layer_source,
                layer_token: None,
                layer_manifest: None,
                pending: None,
                ledger: Vec::new(),
                permits: Vec::new(),
                plan: None,
                failed: false,
            };
            execution.init_type_maps()?;
            execution.start_next_program(decoder,router)?;
            Ok(execution)
        })
    }
}
