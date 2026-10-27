// SPDX-License-Identifier: MPL-2.0
//! Shared whole-model retained controller. Native and browser supply transport only.
use super::publication::ShapeOnlyProduct;
use super::refusal::{RefusalOrigin, RetainedProductRefusal};
use super::runtime::{AsyncRetainedExecutor, NumericalLimits, RuntimeFault};
use super::*;
use ifc_lite_core::SourceBundle;

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
    },
}
#[derive(Debug, Default)]
pub struct ModelSummary {
    pub candidates: usize,
    pub published: usize,
    /// Replacement acquisition attempts after the initial worker slot, including
    /// failed qualification attempts; capped at three per model.
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
    let resolved = crate::prepass::resolve_prepass(&spans, &mut decoder, Default::default());
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
    let jobs = crate::processor::entry_points::canonical_element_jobs(&source);
    let mut attempts = usize::from(worker.is_some());
    if worker
        .as_ref()
        .is_some_and(|w| w.domain().incarnation().is_none())
    {
        *worker = None;
    }
    let max_attempts = usize::from(options.max_restarts.min(3)) + 1;
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
        let mut acquire_ms = 0.;
        let mut bounded_acquire = || {
            if attempts >= max_attempts {
                return Err(RuntimeFault::transport("worker restart budget exhausted"));
            }
            attempts += 1;
            let start = resource::BudgetStart::now();
            let result = acquire();
            acquire_ms += start.elapsed().as_secs_f64() * 1000.;
            result
        };
        let outcome = product(
            &mut decoder,
            &router,
            &snapshot,
            product_id,
            options,
            worker,
            &mut bounded_acquire,
        )
        .await;
        let ms = (product_start.elapsed().as_secs_f64() * 1000. - acquire_ms).max(0.);
        summary.product_ms += ms;
        summary.acquire_ms += acquire_ms;
        // The executor may retire a domain for resource/source cancellation too.
        // Never keep a dead domain merely because its refusal is not transport.
        if worker
            .as_ref()
            .is_some_and(|w| w.domain().incarnation().is_none())
        {
            *worker = None;
        }
        match outcome {
            Ok(shape) => {
                summary.published += 1;
                sink(ProductOutcome::Published(shape), ms);
            }
            Err(error) => {
                let (refusal, origin) = error.refusal();
                if matches!(
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
                    },
                    ms,
                );
            }
        }
    }
    summary.restarts = attempts.saturating_sub(1) as u8;
    Ok(summary)
}

async fn product<W: AsyncRetainedExecutor>(
    decoder: &mut EntityDecoder<'_>,
    router: &GeometryRouter,
    snapshot: &OwnedMeshProductionContext,
    id: u32,
    options: &ModelOptions,
    worker: &mut Option<W>,
    acquire: &mut impl FnMut() -> Result<W, RuntimeFault>,
) -> Result<ShapeOnlyProduct, RetainedExecutionError> {
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
    let job = ElementMeshJob {
        id,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };
    let execution = budget.scope(|| {
        RuntimeProductExecution::begin(
            &job,
            snapshot,
            &MeshProductionOptions::default(),
            decoder,
            router,
        )
    })?;
    let witness =
        super::drive::drive(execution, decoder, router, worker, acquire, options.limits).await?;
    witness.publish_shape()
}
