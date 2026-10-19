// SPDX-License-Identifier: MPL-2.0
//! Selected-processor admission and owned arithmetic for one item occurrence.
use crate::{GeometryRouter, Mesh, Result, ProcessorEmitter};
use crate::construction::ConstructionReports;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use super::OwnedConstructor;
use std::sync::{Arc, Mutex};

/// Shared ownership of accepted source evidence only; numerical reports never
/// enter this cell. Executor cancellation and packet unwind consume it once.
#[derive(Clone)]
pub(crate) struct PendingItemReports(Arc<Mutex<Option<ConstructionReports>>>);
impl PendingItemReports {
    pub(crate) fn take(&self) -> ConstructionReports {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
            .take().unwrap_or_default()
    }
}
struct DetachedUnwindReports(Option<PendingItemReports>);
impl Drop for DetachedUnwindReports {
    fn drop(&mut self) {
        if std::thread::panicking() {
            if let Some(reports)=&self.0 {
                crate::processors::diagnostic_capture::restore_before_current(&reports.take());
            }
        }
    }
}

pub(crate) struct ItemSource {
    pub item: DecodedEntity,
    pub offset: (f64, f64, f64),
    pub phase: ItemPhase,
    pub reports: ConstructionReports,
}
#[derive(Clone, Copy)]
pub(crate) enum ItemPhase { LowerRtc, RtcExtension((f64,f64,f64)), LowerPlain, PlainExtension }
pub(crate) enum ItemStep {
    Source(ItemSource),
    Ready(ReadyItem),
    Complete(ItemResult),
    Child(Box<ChildItem>),
}
pub(crate) struct ChildItem {
    pub program: super::GeometryProgram,
    pub emitter: ProcessorEmitter,
    scale: f64,
    pub(crate) reports: ConstructionReports,
}
impl ChildItem {
    pub(crate) fn finish(mut self) -> ItemStep {
        let retained=self.program.retained.is_some();
        let value=self.program.finish_with_reports();
        self.reports.merge(value.reports);
        if retained { return ItemStep::Complete(ItemResult {result:value.result,reports:self.reports,emitter:Some(self.emitter)}); }
        match value.result.and_then(super::retained::ItemValue::into_mesh) {
            Ok(mesh) => ItemStep::Ready(ReadyItem { plan: ItemRecipe::Mesh(mesh), scale:self.scale, offset:None, reports:self.reports, detached_reports:None, emitter:self.emitter }),
            Err(error) => ItemStep::Ready(ReadyItem { plan:ItemRecipe::Failure(error), scale:self.scale, offset:None,
                reports:self.reports, detached_reports:None, emitter:self.emitter }),
        }
    }
}
enum ItemRecipe { Retained(super::retained::RetainedPlanOperation), Constructor(OwnedConstructor), Mesh(Mesh), Failure(crate::Error) }
pub(crate) struct ReadyItem {
    plan: ItemRecipe,
    scale: f64,
    offset: Option<(f64,f64,f64)>,
    pub(crate) reports: ConstructionReports,
    detached_reports: Option<PendingItemReports>,
    pub emitter: ProcessorEmitter,
}
pub(crate) struct ItemResult {
    pub result: Result<super::retained::ItemValue>,
    pub reports: ConstructionReports,
    pub emitter: Option<ProcessorEmitter>,
}
impl ReadyItem {
    pub(crate) fn detach_reports(&mut self) -> PendingItemReports {
        assert!(self.detached_reports.is_none(), "item reports already detached");
        let reports=PendingItemReports(Arc::new(Mutex::new(Some(std::mem::take(&mut self.reports)))));
        self.detached_reports=Some(reports.clone());
        reports
    }
    pub(crate) fn execute(self) -> ItemResult {
        let ((result, mut reports), numerical) = crate::processors::diagnostic_capture::capture(|| {
            let _detached=DetachedUnwindReports(self.detached_reports);
            let mut reports = UnwindReports(Some(self.reports));
            let result=(|| {
            crate::resource::check_current()?;
            let mut mesh = match self.plan { ItemRecipe::Retained(_) => return Err(crate::Error::geometry("retained construction requires checked processing ledger")), ItemRecipe::Constructor(plan) => plan.evaluate()?, ItemRecipe::Mesh(mesh) => mesh, ItemRecipe::Failure(error) => return Err(error) };
            mesh.validate_indices();
            crate::router::unit_admission::scale_mesh(&mut mesh, self.scale);
            if let Some(offset) = self.offset {
                crate::router::processing::publish_object_frame_bounds(&mut mesh, offset);
            }
            Ok(mesh)
            })();
            (result, reports.0.take().expect("owned source reports"))
        });
        reports.merge(numerical);
        ItemResult { result: crate::resource::observe(result).map(super::retained::ItemValue::Mesh), reports, emitter: Some(self.emitter) }
    }
}
impl ItemSource {
    pub(crate) fn new(item: DecodedEntity, offset: (f64,f64,f64)) -> Self {
        Self { item, offset, phase: ItemPhase::LowerRtc, reports: Default::default() }
    }
    pub(crate) fn execute(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> ItemStep {
        if let Err(stop) = crate::resource::check_current() {
            return ItemStep::Complete(ItemResult { result:Err(stop.into()), reports:self.reports, emitter:None });
        }
        let Some(processor) = router.processor_for(&self.item.ifc_type) else {
            return ItemStep::Complete(ItemResult { result: Err(crate::Error::geometry(format!(
                "Unsupported representation type: {}", self.item.ifc_type))), reports: self.reports, emitter: None });
        };
        let emitter = router.processor_emitter(processor.as_ref());
        if matches!(self.phase, ItemPhase::LowerRtc) {
            let _ = crate::processors::take_curve_capped();
            let _ = crate::processors::take_face_refused();
        }
        let prior=std::mem::take(&mut self.reports);
        let ((next, mut prior), reports) = crate::processors::diagnostic_capture::capture(|| {
            let mut prior=UnwindReports(Some(prior));
            let next=(|| {
            crate::resource::check_current()?;
            match self.phase {
                ItemPhase::LowerRtc => {
                    match router.raw_item_rtc_file_units(&self.item, decoder, self.offset) {
                        Some(rtc) => {
                            router.record_processor_dispatch(processor.as_ref());
                            Ok(match processor.lower_owned(&self.item, decoder, router.tessellation_quality(), Some(rtc)) {
                                Some(plan) => Lowered::Plan(plan, true),
                                None => Lowered::Next(ItemPhase::RtcExtension(rtc)),
                            })
                        }
                        None => Ok(Lowered::Next(ItemPhase::LowerPlain)),
                    }
                }
                ItemPhase::LowerPlain => {
                    router.record_processor_dispatch(processor.as_ref());
                    if let Some(mut program) = processor.lower_program(&self.item, router.tessellation_quality()) {
                        program.bind_processor(self.item.ifc_type.clone(), emitter.expect("selected emitter"));
                        return Ok(Lowered::Program(program));
                    }
                    Ok(match processor.lower_owned(&self.item, decoder, router.tessellation_quality(), None) {
                        Some(plan) => Lowered::Plan(plan, false),
                        None => Lowered::Next(ItemPhase::PlainExtension),
                    })
                }
                ItemPhase::RtcExtension(rtc) => {
                    router.record_processor_dispatch(processor.as_ref());
                    match processor.process_in_rtc_frame(&self.item, decoder, router.schema(), router.tessellation_quality(), rtc) {
                        Some(result) => Ok(Lowered::Mesh(result, true)),
                        None => Ok(Lowered::Next(ItemPhase::LowerPlain)),
                    }
                }
                ItemPhase::PlainExtension => {
                    router.record_processor_dispatch(processor.as_ref());
                    Ok(Lowered::Mesh(processor.process(&self.item,
                        decoder, router.schema(), router.tessellation_quality()), false))
                }
            }
            })();
            (next, prior.0.take().expect("source reports reply"))
        });
        prior.merge(reports);
        self.reports=prior;
        match next {
            Ok(Lowered::Next(phase)) => { self.phase = phase; ItemStep::Source(self) }
            Ok(Lowered::Plan(Ok(plan), rtc)) => ItemStep::Ready(ReadyItem { plan:ItemRecipe::Constructor(plan),
                scale: router.unit_scale(), offset: rtc.then_some(self.offset), reports: self.reports, detached_reports:None,
                emitter: emitter.expect("selected registry processor") }),
            Ok(Lowered::Program(program)) => ItemStep::Child(Box::new(ChildItem { program,
                emitter:emitter.expect("selected emitter"), scale:router.unit_scale(), reports:self.reports })),
            Ok(Lowered::Mesh(result, rtc)) => {
                let result = crate::resource::observe(result).map(|mut mesh| {
                    mesh.validate_indices();
                    router.scale_mesh(&mut mesh);
                    if rtc { crate::router::processing::publish_object_frame_bounds(&mut mesh, self.offset); }
                    mesh
                });
                ItemStep::Complete(ItemResult { result: result.map(super::retained::ItemValue::Mesh), reports: self.reports, emitter })
            }
            Ok(Lowered::Plan(Err(error), _)) | Err(error) => ItemStep::Complete(ItemResult {
                result: crate::resource::observe(Err(error)), reports: self.reports, emitter }),
        }
    }
}
enum Lowered { Program(super::GeometryProgram), Next(ItemPhase), Plan(Result<OwnedConstructor>, bool), Mesh(Result<Mesh>, bool) }

/// Lexical only: a panic forwards earlier reached reports without catching it.
struct UnwindReports(Option<ConstructionReports>);
impl Drop for UnwindReports {
    fn drop(&mut self) {
        if let Some(reports)=&self.0 {crate::processors::diagnostic_capture::restore_before_current(reports);}
    }
}

#[cfg(test)]
#[path = "item_reports_tests.rs"]
mod tests;

impl ItemSource {
    pub(super) fn execute_retained(self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        contract: super::retained::RetainedContract, program: u64) -> ItemStep {
        let result = (|| {
            crate::resource::check_current()?;
            let processor = router.processor_for(&self.item.ifc_type)
                .ok_or_else(|| crate::Error::geometry("retained processor unavailable"))?;
            let emitter = router.processor_emitter(processor.as_ref())
                .filter(|emitter| emitter.origin() == crate::ProcessorEmitterOrigin::Builtin)
                .ok_or_else(|| crate::Error::geometry("retained extension contract unavailable"))?;
            router.record_processor_dispatch(processor.as_ref());
            if let Some(mut child) = processor.lower_program(&self.item,router.tessellation_quality()) {
                child.bind_processor(self.item.ifc_type.clone(),emitter);
                child.retained=Some(contract);
                if let Some(boolean)=&mut child.boolean {boolean.program.select_retained(contract,program);}
                return Ok((None, emitter, Some(child)));
            }
            let operation = super::retained::capture(&self.item, decoder, router.unit_scale(), contract, program)?;
            Ok((Some(operation), emitter, None))
        })();
        match result {
            Ok((None,emitter,Some(program)))=>ItemStep::Child(Box::new(ChildItem {program,emitter,scale:1.,reports:self.reports})),
            Ok((Some(operation), emitter, None)) => ItemStep::Ready(ReadyItem { plan: ItemRecipe::Retained(operation),
                scale: 1., offset: None, reports: self.reports, detached_reports: None, emitter }),
            Err(error) => ItemStep::Complete(ItemResult { result: Err(error), reports: self.reports, emitter: None }),
            _=>unreachable!("retained admission shape"),
        }
    }

}
impl ReadyItem {
    pub(super) fn admit_retained(self) -> Result<(ItemResult, super::retained::RetainedPlanOperation)> {
        let ItemRecipe::Retained(operation) = self.plan else {
            return Err(crate::Error::geometry("exact recipe cannot discharge retained contract"));
        };
        let value=operation.value().try_copy()?;
        Ok((ItemResult { result: Ok(super::retained::ItemValue::Retained(value)),
            reports: self.reports, emitter: Some(self.emitter) },operation))
    }
}
