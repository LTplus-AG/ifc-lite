// SPDX-License-Identifier: MPL-2.0
//! Dedicated alignment attempt, preserving its original no-hygiene completion.
use super::inner::{ProgramError, ProgramStage};
use super::product_control::{ProductConsumer, ProductOutput};
use super::product_control::completion::{CompletedProduct, CompletionPoll, Geometry, ProductCompletion,
    ProductPlacementRequest, PlacementAdmission, ReadyProductPrepare, ReadyProductPlace, ReadyProductJoin};
use super::OwnedConstructor;
use crate::router::{frame_parts::FrameParts, processing::SourceHygiene};
use crate::{GeometryRouter, Mesh, ProcessorEmitter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(super) struct PreludeControl {
    element: DecodedEntity,
    action: Option<PreludeAction>,
    completion: Option<ProductCompletion>,
    output: Option<Result<CompletedProduct>>,
    done: bool,
}
pub(super) enum PreludePoll { Action(PreludeAction), Continue, Complete(Result<CompletedProduct>), Pending }
pub(super) enum PreludeAction {
    AlignmentLower(DecodedEntity), AlignmentExtension(AlignmentExtension), AlignmentReady(ReadyAlignment),
    Prepare(ReadyProductPrepare), Placement(ProductPlacementRequest), Place(ReadyProductPlace), Join(ReadyProductJoin),
}
pub(super) struct PreludeReply { value: PreludeValue, reports: crate::construction::ConstructionReports }
enum PreludeValue {
    Lower(Result<AlignmentAdmission>), Extended(Result<Mesh>, f64), Aligned(Result<Option<Mesh>>),
    Prepared(Geometry), Placement(Result<PlacementAdmission>), Placed(Result<Geometry>), Joined(Result<Vec<Mesh>>),
}
pub(super) enum AlignmentAdmission { Absent, Owned(ReadyAlignment), Extension(AlignmentExtension) }
pub(super) struct AlignmentExtension { element: DecodedEntity, emitter: ProcessorEmitter, scale: f64 }
pub(super) struct ReadyAlignment { recipe: AlignmentRecipe, scale: f64 }
enum AlignmentRecipe { Owned(OwnedConstructor), Mesh(Mesh) }

pub(super) enum PreludeWork { Numerical(PreludeReadyWork), Source(PreludeAction) }

/// Numerical recipes only. Entity snapshots, emitters and continuations stay
/// in the executor's source/control states while this packet runs.
pub(super) enum PreludeReadyWork {
    Alignment(ReadyAlignment), Prepare(ReadyProductPrepare), Place(ReadyProductPlace), Join(ReadyProductJoin),
}
impl PreludeReadyWork {
    pub(super) fn tag(&self) -> u16 {
        match self { Self::Alignment(_)=>2, Self::Prepare(_)=>3, Self::Place(_)=>5, Self::Join(_)=>6 }
    }
    pub(super) fn execute(self) -> PreludeReply {
        let (value,reports) = crate::processors::diagnostic_capture::capture(|| match self {
            Self::Alignment(ready)=>PreludeValue::Aligned(ready.execute()),
            Self::Prepare(ready)=>PreludeValue::Prepared(ready.execute()),
            Self::Place(ready)=>PreludeValue::Placed(ready.execute()),
            Self::Join(ready)=>PreludeValue::Joined(ready.execute()),
        });
        PreludeReply {value,reports}
    }
}
impl PreludeReply {
    pub(super) fn tag(&self) -> u16 {
        match &self.value { PreludeValue::Lower(_)=>0, PreludeValue::Extended(_,_)=>1, PreludeValue::Aligned(_)=>2,
            PreludeValue::Prepared(_)=>3, PreludeValue::Placement(_)=>4, PreludeValue::Placed(_)=>5, PreludeValue::Joined(_)=>6 }
    }
}

impl PreludeControl {
    pub(super) fn new(element: DecodedEntity, consumer: ProductConsumer) -> Self {
        let action = (matches!(consumer, ProductConsumer::Merged) && element.ifc_type == IfcType::IfcAlignment)
            .then(|| PreludeAction::AlignmentLower(element.clone()));
        Self { element, action, completion: None, output: None, done: false }
    }
    pub(super) fn poll(&mut self) -> PreludePoll {
        if let Some(action) = self.action.take() { return PreludePoll::Action(action) }
        if let Some(output) = self.output.take() { self.done = true; return PreludePoll::Complete(output) }
        if self.done { return PreludePoll::Pending }
        if let Some(completion) = &mut self.completion {
            return match completion.poll() {
                CompletionPoll::Prepare(ready) => PreludePoll::Action(PreludeAction::Prepare(ready)),
                CompletionPoll::Source(source) => PreludePoll::Action(PreludeAction::Placement(source)),
                CompletionPoll::Place(ready) => PreludePoll::Action(PreludeAction::Place(ready)),
                CompletionPoll::Join(ready) => PreludePoll::Action(PreludeAction::Join(ready)),
                CompletionPoll::Complete(output) => { self.done = true; PreludePoll::Complete(Ok(output)) }
                CompletionPoll::Pending => PreludePoll::Pending,
            };
        }
        self.done = true;
        PreludePoll::Continue
    }
    pub(super) fn accept(&mut self, reply: PreludeReply) {
        crate::processors::diagnostic_capture::restore(&reply.reports);
        let result = (|| {
            crate::resource::check_current()?;
            match reply.value {
                PreludeValue::Lower(reply) => match ordinary(reply)? {
                    Some(AlignmentAdmission::Owned(ready)) => self.action = Some(PreludeAction::AlignmentReady(ready)),
                    Some(AlignmentAdmission::Extension(extension)) => self.action = Some(PreludeAction::AlignmentExtension(extension)),
                    Some(AlignmentAdmission::Absent) | None => {},
                }
                PreludeValue::Extended(reply, scale) => {
                    if let Some(mesh) = ordinary(reply)? {
                        self.action = Some(PreludeAction::AlignmentReady(ReadyAlignment { recipe: AlignmentRecipe::Mesh(mesh), scale }));
                    }
                }
                PreludeValue::Aligned(reply) => if let Some(mesh) = reply? {
                    self.completion = Some(ProductCompletion::new(self.element.clone(),
                        ProductOutput::Merged((mesh, FrameParts::default(), (Mesh::new(), None))), SourceHygiene::None));
                },
                PreludeValue::Prepared(geometry) => self.completion.as_mut().expect("alignment completion").accept_prepare(geometry),
                PreludeValue::Placement(reply) => self.completion.as_mut().expect("alignment completion").accept_source(reply?),
                PreludeValue::Placed(geometry) => self.completion.as_mut().expect("alignment completion").accept_place(geometry?),
                PreludeValue::Joined(reply) => self.completion.as_mut().expect("alignment completion").accept_join(reply?),
            }
            crate::resource::check_current()?;
            Ok(())
        })();
        if let Err(error) = result { self.action = None; self.completion = None; self.output = Some(Err(error)); }
    }
    pub(super) fn cancel(&mut self) { self.action = None; self.completion = None; self.output = None; self.done = true; }
}
impl PreludeAction {
    pub(super) fn into_work(self) -> PreludeWork {
        PreludeWork::Numerical(match self {
            Self::AlignmentReady(ready)=>PreludeReadyWork::Alignment(ready),
            Self::Prepare(ready)=>PreludeReadyWork::Prepare(ready),
            Self::Place(ready)=>PreludeReadyWork::Place(ready),
            Self::Join(ready)=>PreludeReadyWork::Join(ready),
            source=>return PreludeWork::Source(source),
        })
    }
    pub(super) fn stage(&self) -> ProgramStage {
        match self {
            Self::AlignmentExtension(_) => ProgramStage::Extension,
            Self::AlignmentReady(_) | Self::Prepare(_) | Self::Place(_) | Self::Join(_) => ProgramStage::Numerical,
            Self::AlignmentLower(_) | Self::Placement(_) => ProgramStage::Source,
        }
    }
    pub(super) fn execute(self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>)
        -> std::result::Result<PreludeReply, ProgramError> {
        let source = match self.into_work() { PreludeWork::Numerical(ready)=>return Ok(ready.execute()), PreludeWork::Source(source)=>source };
        let (reply, reports) = crate::processors::diagnostic_capture::capture(|| {
            Ok(match source {
            Self::AlignmentLower(element) => PreludeValue::Lower((|| {
                crate::resource::check_current()?;
                let Some(processor) = router.processor_for(&IfcType::IfcAlignment) else { return Ok(AlignmentAdmission::Absent) };
                router.record_processor_dispatch(processor.as_ref());
                Ok(match processor.lower_owned(&element, decoder, router.tessellation_quality(), None) {
                    Some(plan) => AlignmentAdmission::Owned(ReadyAlignment { recipe: AlignmentRecipe::Owned(plan?), scale: router.unit_scale() }),
                    None => AlignmentAdmission::Extension(AlignmentExtension { element,
                        emitter: router.processor_emitter(processor.as_ref()).expect("selected alignment emitter"), scale: router.unit_scale() }),
                })
            })()),
            Self::AlignmentExtension(extension) => {
                let processor = router.processor_for(&IfcType::IfcAlignment).ok_or(ProgramError::WrongEmitter)?;
                if router.processor_emitter(processor.as_ref()) != Some(extension.emitter) { return Err(ProgramError::WrongEmitter) }
                PreludeValue::Extended(crate::resource::observe(processor.process(&extension.element, decoder,
                    router.schema(), router.tessellation_quality())), extension.scale)
            }
            Self::Placement(source) => PreludeValue::Placement(source.admit(router, decoder)),
            Self::AlignmentReady(_) | Self::Prepare(_) | Self::Place(_) | Self::Join(_) => unreachable!("numerical alignment action extracted"),
            })
        });
        reply.map(|value| PreludeReply { value, reports })
    }
}
impl ReadyAlignment {
    fn execute(self) -> Result<Option<Mesh>> {
        crate::resource::check_current()?;
        let result = match self.recipe { AlignmentRecipe::Owned(plan) => plan.evaluate(), AlignmentRecipe::Mesh(mesh) => Ok(mesh) };
        let Some(mut mesh) = ordinary(crate::resource::observe(result))? else { return Ok(None) };
        if mesh.positions.is_empty() { return Ok(None) }
        mesh.validate_indices();
        if self.scale != 1. {
            let scale = self.scale as f32;
            for position in &mut mesh.positions { *position *= scale; }
        }
        crate::resource::check_current()?;
        Ok(Some(mesh))
    }
}
fn ordinary<T>(result: Result<T>) -> Result<Option<T>> {
    match crate::resource::observe(result) {
        Ok(value) => Ok(Some(value)), Err(error @ crate::Error::ProgramStopped(_)) => Err(error), Err(_) => Ok(None),
    }
}

#[cfg(test)]
#[path = "inner_product_prelude_tests.rs"]
mod tests;
