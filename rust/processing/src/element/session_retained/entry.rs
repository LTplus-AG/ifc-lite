// SPDX-License-Identifier: MPL-2.0
use super::*;
impl<'a, R: NumericalReceipt> RuntimeProductExecution<'a, R> {
    pub(super) fn begin(
        job: &'a ElementMeshJob<'a>,
        context: &'a OwnedMeshProductionContext,
        options: &MeshProductionOptions,
        openings: &'a [DecodedEntity],
        layers: super::layers::ProductLayers,
        decoder: &mut EntityDecoder,
        router: &GeometryRouter,
    ) -> Result<Self, RetainedExecutionError> {
        let mut layers = layers;
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
                    // Exact admission/merge precedes any opening source validation.
                    let layers = if matches!(planned.as_ref(), Some(((super::super::plan::PlanKind::Product { layer_class, .. }, _), _, _, _)) if *layer_class != 0) {
                        check_resources(&resources)?;
                        // The caller admitted under the plan's own predicate.
                        let admitted = layers.take().ok_or(RetainedExecutionError::Source(RetainedContextError::Mismatched))?;
                        match admitted.map_err(RetainedExecutionError::LayerStrategy)? {
                            ifc_lite_geometry::program::transactions::LayerAdmission::Bands(spec) => Some(spec),
                            _ => None,
                        }
                    } else { None };
                    openings::validate_openings(context, job.id, openings, d, r)?;
                    Ok::<_, RetainedExecutionError>((resources, planned, terminal, layers))
                })
                .map_err(protocol)
                .and_then(|(result, stamp)| result.map(|result| (result, stamp)));
            // The original stop also wins when source planning returned an
            // error before its owner/resource scopes finished unwinding.
            if let Some(resources) = captured_resources {
                check_resources(&resources)?;
            }
            let ((resources, planned, terminal, layers), _) = prepared?;
            check_resources(&resources)?;
            let layer_class = match planned.as_ref() {
                Some(((super::super::plan::PlanKind::Product { layer_class, .. }, _), _, _, _)) => *layer_class,
                _ => 0,
            };
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
                openings: None,
                layer_class,
                layer_spec: layers,
                layer_active: false,
                layer_start: None,
                band_ms: 0.,
                opening_entities: openings,
                type_values: Vec::new(),
                type_map_members: Default::default(),
                type_map_members_planned: Default::default(),
                pending: None,
                prepared: None,
                ledger: Vec::new(),
                permits: Storage::default(),
                scratch: Storage::default(),
                plan: None,
                cut_times_ms: Vec::new(),
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
