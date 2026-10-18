// SPDX-License-Identifier: MPL-2.0
//! Numerical host operations. No source, router or source callback is an input.
use super::effects::{Effect, EffectSet};
use crate::router::voids::ReadyVoidContext;
use crate::{BoolFailure, Mesh, TessellationQuality};
use std::cell::RefCell;

/// Lazy numerical gate policy. Each gate is read only at its original reached
/// route, after source callbacks; capturing this policy initializes no OnceLock.
#[derive(Clone, Copy)]
pub(crate) struct Configuration {
    pub(crate) parametric: fn() -> bool,
    pub(crate) rectangular: fn() -> bool,
    pub(crate) prism: fn() -> bool,
    pub(crate) coaxial_union: fn() -> bool,
}

/// Linear operation over the actual placed host and admitted cutter context.
/// The immutable context may be reused for another material layer/frame part.
pub(crate) struct ReadyOperation<'a> {
    mesh: Mesh,
    context: &'a ReadyVoidContext,
    id: u32,
    quality: TessellationQuality,
    configuration: Configuration,
}
pub(crate) struct NumericalOutcome {
    result: std::thread::Result<crate::Result<Mesh>>,
    effects: EffectSet,
    telemetry: crate::telemetry_transaction::EffectSet,
}
impl NumericalOutcome {
    pub(crate) fn publish(self, router: &crate::GeometryRouter) -> crate::Result<Mesh> {
        match self.result {
            Ok(result) => match crate::resource::observe(result) {
                Ok(mesh) => {
                    self.effects.publish(router);
                    self.telemetry.commit();
                    Ok(mesh)
                }
                Err(error) => {
                    self.effects.publish_failures(router);
                    Err(error)
                }
            },
            Err(panic) => {
                self.effects.publish(router);
                self.telemetry.commit();
                std::panic::resume_unwind(panic)
            },
        }
    }
}
impl<'a> ReadyOperation<'a> {
    pub(crate) fn new(
        mesh: Mesh,
        context: &'a ReadyVoidContext,
        id: u32,
        quality: TessellationQuality,
        configuration: Configuration,
    ) -> Self {
        Self {
            mesh,
            context,
            id,
            quality,
            configuration,
        }
    }
    pub(crate) fn execute(self) -> NumericalOutcome {
        let execution = Execution::new(self.quality, self.configuration);
        let (result, telemetry) = crate::telemetry_transaction::capture(|| {
            // Restore completed parent effects even when only the current
            // speculative child unwinds; the child's capture guard discards
            // its telemetry before this catch. No geometry-loss fallback.
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                execution.apply_void_context(self.mesh, self.context, self.id)
            }))
        });
        NumericalOutcome {
            result,
            effects: execution.finish(),
            telemetry,
        }
    }
}

/// Interior mutability is request-owned; no RefCell borrow spans a child call.
/// A mixed child has its own set: refusal/unwind simply drops that set.
pub(crate) struct NumericalSnapshot(EffectSet);

pub(crate) struct Execution {
    pub(crate) tessellation_quality: TessellationQuality,
    pub(crate) configuration: Configuration,
    effects: RefCell<EffectSet>,
}
/// Lexical numerical ownership only: drains reached kernel evidence on every
/// exit, including a terminal barrier before the normal finalizer is reached.
pub(crate) struct FailureCapture<'a> {
    execution: &'a Execution,
    clipper: &'a crate::csg::ClippingProcessor,
    id: u32,
}
impl Drop for FailureCapture<'_> {
    fn drop(&mut self) {
        self.execution.drain_failures(self.clipper, self.id);
    }
}
impl Execution {
    pub(crate) fn new(
        tessellation_quality: TessellationQuality,
        configuration: Configuration,
    ) -> Self {
        Self {
            tessellation_quality,
            configuration,
            effects: RefCell::new(EffectSet::default()),
        }
    }
    pub(crate) fn snapshot(&self) -> NumericalSnapshot { NumericalSnapshot(self.effects.borrow().clone()) }
    pub(crate) fn restore(&self, snapshot: NumericalSnapshot) { *self.effects.borrow_mut() = snapshot.0; }
    pub(crate) fn finish(self) -> EffectSet {
        self.effects.into_inner()
    }
    pub(crate) fn accept(&self, child: Self) {
        self.effects.borrow_mut().append(child.finish());
    }
    pub(crate) fn capture_failures<'a>(&'a self, clipper: &'a crate::csg::ClippingProcessor,
        id: u32) -> FailureCapture<'a> {
        FailureCapture { execution: self, clipper, id }
    }
    pub(crate) fn drain_failures(&self, clipper: &crate::csg::ClippingProcessor, id: u32) {
        let failures = clipper.take_failures();
        if !failures.is_empty() {
            self.record_host_failure_summary(id, &failures);
            self.record_csg_failures(id, failures);
        }
    }
    pub(crate) fn record_rect_fast(&self, stats: &crate::rect_fast::RectFastStats) {
        self.effects.borrow_mut().push(Effect::Rect(*stats));
    }
    pub(crate) fn record_host_failure_summary(&self, id: u32, failures: &[BoolFailure]) {
        self.effects
            .borrow_mut()
            .push(Effect::FailureSummary(id, failures.to_vec()));
    }
    pub(crate) fn record_csg_failures(&self, id: u32, failures: Vec<BoolFailure>) {
        self.effects
            .borrow_mut()
            .push(Effect::Failures(id, failures));
    }
    pub(crate) fn record_void_consumed_host(&self, id: u32) {
        self.effects.borrow_mut().push(Effect::Consumed(id));
    }
    pub(crate) fn record_host_cut_effect(
        &self,
        id: u32,
        before: usize,
        after: usize,
        rectangles: usize,
        bounds: ((f32, f32, f32), (f32, f32, f32)),
    ) {
        self.effects.borrow_mut().push(Effect::Cut {
            id,
            before,
            after,
            rectangles,
            bounds,
        });
    }
}

#[cfg(test)]
#[path = "execute_tests.rs"]
mod tests;
