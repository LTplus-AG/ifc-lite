// SPDX-License-Identifier: MPL-2.0
//! Shared whole-model retained controller. Native and browser supply transport only.
use super::publication::ShapeOnlyProduct;
use super::refusal::{RefusalOrigin, RetainedProductRefusal};
use super::runtime::{AsyncRetainedExecutor, NumericalLimits, RuntimeFault};
use super::*;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::program::transactions::LayerUsages;

#[derive(Clone, Copy)]
pub struct ProductBudgetSpec {
    pub work: u64,
    pub bytes: u64,
    pub deadline_ms: u64,
}
impl Default for ProductBudgetSpec {
    fn default() -> Self {
        Self {
            work: 10_000_000,
            bytes: 256 << 20,
            deadline_ms: 30_000,
        }
    }
}
pub struct ModelOptions {
    pub limits: NumericalLimits,
    pub product_budget: ProductBudgetSpec,
    pub max_restarts: u8,
    pub ids: Option<FxHashSet<u32>>,
}
impl Default for ModelOptions {
    fn default() -> Self {
        Self {
            limits: NumericalLimits {
                chord_metres: 0.001,
                angle_degrees: 5.,
                max_bytes: 16 << 20,
            },
            product_budget: ProductBudgetSpec::default(),
            max_restarts: 3,
            ids: None,
        }
    }
}
#[derive(Debug)]
pub enum ProductOutcome {
    Published(ShapeOnlyProduct),
    Refused {
        product_id: u32,
        ifc_type: IfcType,
        refusal: RetainedProductRefusal,
        origin: Option<RefusalOrigin>,
        message: String,
        /// Attempted opening cuts, including a failed or consuming invocation.
        cut_times_ms: Vec<f64>,
    },
}
#[derive(Debug, Default)]
pub struct ModelSummary {
    pub candidates: usize,
    pub published: usize,
    pub layered_products: usize,
    pub bands: usize,
    /// Attempted opening cuts across published and refused products.
    pub cuts: u64,
    /// Charged recovery attempts, including failed qualification and deliberate
    /// replacements beyond the first sixteen; capped at three per model.
    pub restarts: u8,
    pub product_ms: f64,
    pub acquire_ms: f64,
    pub by_code: std::collections::BTreeMap<&'static str, usize>,
}

pub async fn run_model<W: AsyncRetainedExecutor>(
    source: Arc<SourceBundle>,
    options: &ModelOptions,
    acquire: impl FnMut() -> Result<W, RuntimeFault>,
    mut sink: impl FnMut(ProductOutcome),
) -> Result<ModelSummary, RetainedExecutionError> {
    run_model_with_worker(source, options, &mut None, acquire, |outcome, _| {
        sink(outcome)
    })
    .await
}

/// Reuse a qualified peer across model boundaries. Each model has its own
/// replacement budget. Sink milliseconds exclude acquisition and sink work.
pub async fn run_model_with_worker<W: AsyncRetainedExecutor>(
    source: Arc<SourceBundle>,
    options: &ModelOptions,
    worker: &mut Option<W>,
    mut acquire: impl FnMut() -> Result<W, RuntimeFault>,
    mut sink: impl FnMut(ProductOutcome, f64),
) -> Result<ModelSummary, RetainedExecutionError> {
    options.limits.validate()?;
    let mut decoder = source.decoder().with_strict_reals();
    let mut spans = crate::prepass::PrepassSpans::default();
    let mut scanner = ifc_lite_core::EntityScanner::new(source.bytes());
    while let Some((id, name, start, end)) = scanner.next_entity() {
        spans.stash(name, id, start, end);
    }
    let mut resolved = crate::prepass::resolve_prepass(&spans, &mut decoder, Default::default());
    super::presentation::material_styles::join(&mut resolved, &mut decoder);
    let snapshot = ProductionModel::from_source(source.clone()).snapshot(OwnedMeshProductionData {
        void_index: Arc::new(resolved.void_index),
        geometry_style_index: Arc::new(resolved.geometry_style_index),
        indexed_colour_full: Arc::new(resolved.indexed_colour_full),
        element_material_colors: Arc::new(resolved.element_material_colors),
        ..Default::default()
    });
    let mut router = GeometryRouter::with_units(source.bytes(), &mut decoder);
    router.set_material_layer_index(Arc::new(
        ifc_lite_geometry::MaterialLayerIndex::from_content(source.bytes(), &mut decoder),
    ));
    let usages = LayerUsages::from_content(source.bytes(), &mut decoder);
    let (jobs, type_maps) = crate::processor::entry_points::canonical_jobs_and_type_maps(&source);
    let mut restart_budget = super::restart_budget::RestartBudget::new(options.max_restarts, worker.is_some());
    if worker
        .as_ref()
        .is_some_and(|w| w.domain().incarnation().is_none())
    {
        *worker = None;
    }
    let mut summary = ModelSummary::default();
    for (product_id, ifc_type) in jobs {
        if options
            .ids
            .as_ref()
            .is_some_and(|ids| !ids.contains(&product_id))
        {
            continue;
        }
        summary.candidates += 1;
        let product_start = resource::BudgetStart::now();
        let layer_allowance_spent = restart_budget.layer_allowance_spent();
        let mut acquire_ms = 0.;
        let mut bounded_acquire = || {
            restart_budget.acquire(|| {
                let start = resource::BudgetStart::now();
                let result = acquire();
                acquire_ms += start.elapsed().as_secs_f64() * 1000.;
                result
            })
        };
        let mut observation = ProductObservation::new(product_id);
        let outcome = product(
            &mut decoder,
            &router,
            &usages,
            &snapshot,
            &mut observation,
            options,
            layer_allowance_spent,
            worker,
            &mut bounded_acquire,
            type_maps.get(&product_id).map(Vec::as_slice),
        )
        .await;
        let ms = (product_start.elapsed().as_secs_f64() * 1000. - acquire_ms).max(0.);
        summary.product_ms += ms;
        summary.acquire_ms += acquire_ms;
        summary.cuts += observation.cut_times_ms.len() as u64;
        // The executor may retire a domain for resource/source cancellation too.
        // Never keep a dead domain merely because its refusal is not transport.
        if worker
            .as_ref()
            .is_some_and(|w| w.domain().incarnation().is_none())
        {
            // Classify by who retired the captured domain, never by the error
            // variant (which may also describe a stop after an independent fault).
            if observation.cancellation.as_ref().is_some_and(|c| c.controller_retired()) {
                restart_budget.deliberate_retirement();
            } else if observation.layer_phase {
                // A band-phase fault spends only the layer allowance, never the
                // restarts later non-layer products need (#7955).
                restart_budget.layer_retirement();
            }
            *worker = None;
        }
        match outcome {
            Ok(shape) => {
                summary.published += 1;
                let bands = shape.parts.iter().filter(|p| p.layer.is_some()).count();
                summary.layered_products += usize::from(bands != 0);
                summary.bands += bands;
                sink(ProductOutcome::Published(shape), ms);
            }
            Err(error) => {
                let (refusal, origin) = error.refusal();
                if !matches!(error, RetainedExecutionError::LayerRetirementsExhausted) && matches!(
                    refusal,
                    RetainedProductRefusal::WorkerFault | RetainedProductRefusal::WorkerRetired
                ) {
                    *worker = None;
                }
                *summary.by_code.entry(refusal.code()).or_default() += 1;
                sink(
                    ProductOutcome::Refused {
                        product_id,
                        ifc_type,
                        refusal,
                        origin,
                        message: error.to_string(),
                        cut_times_ms: observation.cut_times_ms,
                    },
                    ms,
                );
            }
        }
    }
    summary.restarts = restart_budget.restarts();
    Ok(summary)
}

pub(super) struct ProductObservation<R: NumericalReceipt> {
    id: u32,
    pub(super) cut_times_ms: Vec<f64>,
    pub(super) cancellation: Option<RuntimeCancellation<R>>,
    /// The last issued transaction belonged to the M4 band phase.
    pub(super) layer_phase: bool,
}
impl<R: NumericalReceipt> ProductObservation<R> {
    pub(super) fn new(id: u32) -> Self {
        Self { id, cut_times_ms: Vec::new(), cancellation: None, layer_phase: false }
    }
}

#[allow(clippy::too_many_arguments)] // One product's source, budget, transport and planned type maps.
async fn product<W: AsyncRetainedExecutor>(
    decoder: &mut EntityDecoder<'_>,
    router: &GeometryRouter,
    usages: &LayerUsages,
    snapshot: &OwnedMeshProductionContext,
    observation: &mut ProductObservation<W::Receipt>,
    options: &ModelOptions,
    layer_allowance_spent: bool,
    worker: &mut Option<W>,
    acquire: &mut impl FnMut() -> Result<W, RuntimeFault>,
    type_maps: Option<&[(u32, u8)]>,
) -> Result<ShapeOnlyProduct, RetainedExecutionError> {
    let id = observation.id;
    let spec = options.product_budget;
    let budget = resource::ProductBudget::new(
        resource::BudgetStart::now(),
        spec.work,
        spec.bytes,
        spec.deadline_ms,
    );
    let entity = budget
        .scope(|| decoder.decode_by_id(id))
        .map_err(RetainedExecutionError::Core)?;
    let kind = budget.scope(|| -> Result<_, RetainedExecutionError> {
        type_maps.map_or(Ok(ElementJobKind::Product), |maps| {
            let mut rep_maps = Vec::new();
            OwnedResourceContext::capture_current().reserve_headers(&mut rep_maps, maps.len())
                .map_err(RetainedExecutionError::Stopped)?.retain();
            rep_maps.extend_from_slice(maps);
            Ok(ElementJobKind::TypeProduct { rep_maps })
        })
    })?;
    let job = ElementMeshJob {
        id,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind,
        element_color: None,
        metadata: None,
    };
    let layers = budget.scope(|| super::layers::admit(&entity, router, usages, decoder))?;
    let openings = budget.scope(|| openings::decoded_openings(snapshot, id, &layers, decoder, router))?;
    let execution = budget.scope(|| {
        RuntimeProductExecution::begin(
            &job,
            snapshot,
            &MeshProductionOptions::default(),
            &openings,
            layers,
            decoder,
            router,
        )
    })?;
    // Plan-time refusals keep precedence; no kernel call has been issued yet.
    if layer_allowance_spent && execution.layer_spec.is_some() {
        return Err(RetainedExecutionError::LayerRetirementsExhausted);
    }
    let witness =
        super::drive::drive(execution, decoder, router, worker, acquire, options.limits,
            observation).await?;
    witness.publish_shape()
}
