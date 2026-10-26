// SPDX-License-Identifier: MPL-2.0
use super::*;
impl<'a, R: NumericalReceipt> RuntimeProductExecution<'a, R> {
    pub(super) fn begin(
        job: &'a ElementMeshJob<'a>,
        context: &'a OwnedMeshProductionContext,
        options: &MeshProductionOptions,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<Self, RetainedExecutionError> {
        if context.source().is_none() {
            return Err(RetainedExecutionError::Source(
                RetainedContextError::Missing,
            ));
        }
        context
            .validate_decoder(decoder)
            .map_err(RetainedExecutionError::Source)?;
        super::super::session_canonical::with_source_resources(decoder, |decoder| {
            resource::check_current().map_err(RetainedExecutionError::Stopped)?;
            let mut owner = ProductOwner::admit(decoder, router).map_err(protocol)?;
            let mut scopes = Scopes::new();
            let mut captured_resources = None;
            let prepared = owner
                .work(decoder, router, |d, r| {
                    let resources = OwnedResourceContext::capture_current();
                    captured_resources = Some(resources.clone());
                    check_resources(&resources)?;
                    resource::charge(resource::Cost {
                        work: 1,
                        ..Default::default()
                    })
                    .map_err(RetainedExecutionError::Stopped)?
                    .retain();
                    let actual = d
                        .decode_by_id(job.id)
                        .map_err(RetainedExecutionError::Core)?;
                    if actual.id != job.entity.id
                        || actual.ifc_type != job.ifc_type
                        || actual.ifc_type != job.entity.ifc_type
                        || !Arc::ptr_eq(&actual.attributes, &job.entity.attributes)
                    {
                        return Err(RetainedExecutionError::Source(
                            RetainedContextError::Mismatched,
                        ));
                    }
                    let (planned, terminal) = scopes
                        .with_scope(|| plan_in_scope(job, &context.borrowed(), options, d, r));
                    Ok::<_, RetainedExecutionError>((resources, planned, terminal))
                })
                .map_err(protocol)
                .and_then(|(result, stamp)| result.map(|result| (result, stamp)));
            // The original stop also wins when source planning returned an
            // error before its owner/resource scopes finished unwinding.
            if let Some(resources) = captured_resources {
                check_resources(&resources)?;
            }
            let ((resources, planned, terminal), _) = prepared?;
            check_resources(&resources)?;
            let state = ProductState::planned(job, planned, terminal, Some(context.id()), None);
            if let Some(stop) = state.terminal() {
                return Err(RetainedExecutionError::Stopped(stop));
            }
            let (source_epoch, source_revision) = context.lifecycle().epoch_revision();
            let traversal =
                resources.with_scope(|| RetainedTraversal::new(source_epoch, source_revision));
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
                pending: None,
                prepared: None,
                ledger: Vec::new(),
                permits: Storage::default(),
                scratch: Storage::default(),
                plan: None,
                failed: false,
                runtime_domain: None,
            };
            execution.init_type_maps()?;
            execution.start_next_program(decoder, router)?;
            execution.refuse_incomplete_shape(decoder, router)?;
            Ok(execution)
        })
    }
}
