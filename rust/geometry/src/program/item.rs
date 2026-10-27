// SPDX-License-Identifier: MPL-2.0
//! Selected-processor admission and owned arithmetic for one item occurrence.
//!
//! Source phases reach the router's currently selected processor in the
//! historical order: owned lowering in the RTC frame, the RTC extension hook,
//! plain owned lowering, then the plain extension callback. Only an admitted
//! owned constructor becomes a numerical recipe; it evaluates without source.
//! A selected Boolean/CSG processor's extension is its continuation instead,
//! driven here one source or numerical step at a time.
#[path = "retained/item.rs"]
mod retained_impl;
use super::boolean::BooleanMachine;
use super::inner::{ProgramError, ProgramStage};
use super::OwnedConstructor;
use super::retained::{RetainedSelection, RetainedPlanOperation, LogicalRetainedValue};
use crate::construction::ConstructionReports;
use crate::processors::diagnostic_capture;
use crate::{Error, GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

#[derive(Clone, Copy)]
pub(super) enum ItemPhase {
    LowerRtc,
    RtcExtension((f64, f64, f64)),
    LowerPlain,
    PlainExtension,
}

/// One owned step of an item occurrence. Replies move it; tickets never hold it.
pub(super) enum ItemStep {
    Source { phase: ItemPhase, reports: ConstructionReports },
    Ready(ReadyItem),
    /// The selected processor's Boolean/CSG continuation, mid-walk. Boxed: the
    /// step moves with every reply, and the continuation owns a mesh and stacks.
    Boolean { machine: Box<BooleanMachine>, reports: ConstructionReports },
    // RetainedSelection is uninhabited on default wasm; keep the shared reply match.
    #[cfg_attr(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")), allow(dead_code))]
    RetainedReady(Box<RetainedPlanOperation>, RetainedSelection),
    // Keep retained frames out of the inline exact reply/controller layout.
    // Like RetainedReady, this carrier cannot be constructed on default wasm.
    #[cfg_attr(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")), allow(dead_code))]
    RetainedComplete(Result<Box<LogicalRetainedValue>>, RetainedSelection),
    Complete(ItemResult),
}

/// Source-free numerical recipe: the admitted constructor plus its unit scale
/// and, when it was lowered in an RTC frame, the offset its bounds publish.
pub(super) struct ReadyItem {
    plan: OwnedConstructor,
    scale: f64,
    offset: Option<(f64, f64, f64)>,
    reports: ConstructionReports,
}

pub(super) struct ItemResult {
    result: Result<Mesh>,
    reports: ConstructionReports,
}

/// The item controller: owns only its step. The source occurrence is lent by
/// its owner on every source step, so an owning walk can drive it in place.
pub(super) struct ItemControl {
    pub(super) retained: Option<RetainedSelection>,
    offset: (f64, f64, f64),
    step: Option<ItemStep>,
}

impl ItemControl {
    pub(super) fn new(offset: (f64, f64, f64)) -> Self {
        let reports = ConstructionReports::default();
        Self { retained: None, offset, step: Some(ItemStep::Source { phase: ItemPhase::LowerRtc, reports }) }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        Ok(match self.step.as_ref().ok_or(ProgramError::Outstanding)? {
            ItemStep::Source { phase: ItemPhase::RtcExtension(_) | ItemPhase::PlainExtension, .. } => {
                Some(ProgramStage::Extension)
            }
            ItemStep::Source { .. } => Some(ProgramStage::Source),
            ItemStep::RetainedReady(..) => Some(ProgramStage::Numerical),
            ItemStep::RetainedComplete(..) => None,
            ItemStep::Ready(_) => Some(ProgramStage::Numerical),
            ItemStep::Boolean { machine, .. } => Some(machine.stage().ok_or(ProgramError::Outstanding)?),
            ItemStep::Complete(_) => None,
        })
    }

    /// Move the requested step out before any callback can unwind, so a
    /// panicking processor leaves no recipe behind to replay.
    pub(super) fn execute(&mut self, item: &DecodedEntity, router: &GeometryRouter,
        decoder: &mut EntityDecoder) -> std::result::Result<ItemStep, ProgramError> {
        if self.retained_ready() { return Err(ProgramError::UnsupportedRetained); }
        Ok(match self.step.take().ok_or(ProgramError::StaleRequest)? {
            ItemStep::Source { phase, reports } => {
                if let Some(selection) = &self.retained {
                    selection.execute(item, router, decoder)
                } else { execute_source(item, self.offset, phase, reports, router, decoder) }
            }
            ItemStep::Ready(ready) => ItemStep::Complete(ready.execute()),
            ItemStep::Boolean { machine, reports } => execute_boolean(item, machine, reports, router, decoder),
            ItemStep::Complete(value) => ItemStep::Complete(value),
            other @ (ItemStep::RetainedReady(..) | ItemStep::RetainedComplete(..)) => other,
        })
    }

    /// Accept a validated step. A completed item publishes its source and
    /// numerical reports to the router exactly once, success or failure.
    pub(super) fn accept(&mut self, mut step: ItemStep, router: &GeometryRouter) {
        if let ItemStep::Boolean { machine, .. } = &mut step {
            if let Err(error) = machine.accept_retained_mapping(router) {
                if let Some(selection) = machine.retained_selection().cloned() {
                    step = ItemStep::RetainedComplete(Err(error), selection);
                }
            }
        }
        if let ItemStep::Complete(value) = &mut step {
            let reports = std::mem::take(&mut value.reports);
            if reports.curve_capped {
                router.record_unsupported_item(IfcType::IfcBSplineCurveWithKnots);
            }
            // A face refused because its loop, curve or surface data does not
            // read (#7687, D3): the brep skips it per face, so this is the only
            // place the drop becomes visible.
            for face_type in reports.face_refused {
                router.record_unsupported_item(face_type);
            }
        }
        self.step = Some(step);
    }

    pub(super) fn take_result(&mut self) -> Option<Result<Mesh>> {
        match self.step.take() {
            Some(ItemStep::Complete(value)) => Some(value.result),
            other => {
                self.step = other;
                None
            }
        }
    }
}

enum Lowered {
    Next(ItemPhase),
    Plan(Result<OwnedConstructor>, bool),
    Mesh(Result<Mesh>, bool),
}

fn execute_source(
    item: &DecodedEntity,
    offset: (f64, f64, f64),
    phase: ItemPhase,
    prior: ConstructionReports,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> ItemStep {
    let Some(processor) = router.processor_for(&item.ifc_type) else {
        // No processor is registered for this type. Every `GeometryCategory`
        // with a real implementation is caught by the lookup; `MappedItem`
        // never reaches here (the gateway intercepts it first). So landing
        // here means the type is genuinely unsupported.
        let result = Err(Error::geometry(format!("Unsupported representation type: {}", item.ifc_type)));
        return ItemStep::Complete(ItemResult { result, reports: prior });
    };
    if matches!(phase, ItemPhase::LowerRtc) {
        // Drop flags a direct `AdvancedBrepProcessor` call left set on this
        // thread: the captures below must count THIS item only (#7687).
        let _ = crate::processors::take_curve_capped();
        let _ = crate::processors::take_face_refused();
    }
    let quality = router.tessellation_quality();
    let ((lowered, mut reports), reached) = diagnostic_capture::capture(|| {
        let mut prior = UnwindReports(Some(prior));
        let lower_plain = |decoder: &mut EntityDecoder| {
            match processor.lower_owned(item, decoder, quality, None) {
                Some(plan) => Lowered::Plan(plan, false),
                None => Lowered::Next(ItemPhase::PlainExtension),
            }
        };
        let lowered = match phase {
            // Raw-coordinate items rebase by `offset` (model RTC in the item's
            // own frame) in f64 before f32 narrowing, only when that reduces
            // their coordinate magnitude (#5684, #5698).
            ItemPhase::LowerRtc => match router.raw_item_rtc_file_units(item, decoder, offset) {
                Some(rtc) => match processor.lower_owned(item, decoder, quality, Some(rtc)) {
                    Some(plan) => Lowered::Plan(plan, true),
                    None => Lowered::Next(ItemPhase::RtcExtension(rtc)),
                },
                // No rebase: plain lowering is the same source stage, so it
                // runs in this step rather than costing a round trip per item.
                None => lower_plain(decoder),
            },
            ItemPhase::RtcExtension(rtc) => {
                match processor.process_in_rtc_frame(item, decoder, router.schema(), quality, rtc) {
                    Some(result) => Lowered::Mesh(result, true),
                    None => Lowered::Next(ItemPhase::LowerPlain),
                }
            }
            ItemPhase::LowerPlain => lower_plain(decoder),
            ItemPhase::PlainExtension => {
                Lowered::Mesh(processor.process(item, decoder, router.schema(), quality), false)
            }
        };
        (lowered, prior.take())
    });
    reports.merge(reached);
    let rtc_offset = |rebased: bool| rebased.then_some(offset);
    match lowered {
        // The extension of a selected Boolean/CSG processor is its
        // continuation, run as the item's own steps.
        Lowered::Next(ItemPhase::PlainExtension) if processor.boolean_recorder().is_some() => {
            ItemStep::Boolean { machine: Box::new(BooleanMachine::new(item, quality)), reports }
        }
        Lowered::Next(phase) => ItemStep::Source { phase, reports },
        Lowered::Plan(Ok(plan), rebased) => ItemStep::Ready(ReadyItem {
            plan,
            scale: router.unit_scale(),
            offset: rtc_offset(rebased),
            reports,
        }),
        Lowered::Plan(Err(error), _) => ItemStep::Complete(ItemResult { result: Err(error), reports }),
        Lowered::Mesh(result, rebased) => {
            let result = result.map(|mut mesh| {
                crate::router::processing::finish_item_mesh(&mut mesh, router.unit_scale(), rtc_offset(rebased));
                mesh
            });
            ItemStep::Complete(ItemResult { result, reports })
        }
    }
}

/// One continuation step through the selected processor's recorder: a
/// source step reads the decoder, a numerical step only its owned operands.
/// A resource stop ends the item before the step runs.
fn execute_boolean(
    item: &DecodedEntity,
    mut machine: Box<BooleanMachine>,
    prior: ConstructionReports,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> ItemStep {
    if machine.retained_selection().is_some() { return retained_impl::execute_boolean(item, machine, prior, router, decoder); }
    let recorder = router.processor_for(&item.ifc_type).and_then(|processor| processor.boolean_recorder());
    let Some(recorder) = recorder else {
        let result = Err(Error::geometry("the selected processor no longer records this boolean"));
        return ItemStep::Complete(ItemResult { result, reports: prior });
    };
    if let Err(stop) = crate::resource::check_current() {
        machine.abandon(recorder);
        return ItemStep::Complete(ItemResult { result: Err(stop.into()), reports: prior });
    }
    let numerical = machine.stage() == Some(ProgramStage::Numerical);
    let ((result, mut reports), reached) = diagnostic_capture::capture(|| {
        let mut prior = UnwindReports(Some(prior));
        let stepped = if numerical { machine.numerical(recorder) } else { machine.source(recorder, decoder) };
        let result = stepped.and_then(|()| match machine.stage() {
            Some(_) => Ok(None),
            None => machine.finish().map(|(mesh, _)| Some(mesh)),
        });
        (result, prior.take())
    });
    reports.merge(reached);
    let result = match result {
        Ok(None) => return ItemStep::Boolean { machine, reports },
        Ok(Some(mut mesh)) => {
            crate::router::processing::finish_item_mesh(&mut mesh, router.unit_scale(), None);
            Ok(mesh)
        }
        Err(error) => {
            machine.abandon_on_stop(&error, recorder);
            Err(error)
        }
    };
    ItemStep::Complete(ItemResult { result, reports })
}

impl ReadyItem {
    fn execute(self) -> ItemResult {
        let Self { plan, scale, offset, reports } = self;
        let ((result, mut reports), numerical) = diagnostic_capture::capture(|| {
            let mut reports = UnwindReports(Some(reports));
            let result = plan.evaluate().map(|mut mesh| {
                crate::router::processing::finish_item_mesh(&mut mesh, scale, offset);
                mesh
            });
            (result, reports.take())
        });
        reports.merge(numerical);
        ItemResult { result, reports }
    }
}

/// Lexical only: a panic forwards earlier reached reports ahead of the
/// unwinding phase's own, as one uninterrupted processor call left them.
struct UnwindReports(Option<ConstructionReports>);
impl UnwindReports {
    fn take(&mut self) -> ConstructionReports {
        self.0.take().unwrap_or_default()
    }
}
impl Drop for UnwindReports {
    fn drop(&mut self) {
        if let Some(reports) = &self.0 {
            diagnostic_capture::restore_before_current(reports);
        }
    }
}
