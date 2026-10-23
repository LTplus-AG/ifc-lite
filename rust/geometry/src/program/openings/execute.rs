// SPDX-License-Identifier: MPL-2.0
//! Numerical host cuts. A cut runs over an owned host mesh and an immutable
//! classified context; no decoder, source entity or router is an input. Its
//! diagnostics are buffered in request order and published once, by the
//! caller, after the outcome is observed.
use super::effects::{Effect, EffectSet};
use crate::csg::ClippingProcessor;
use crate::router::voids::VoidContext;
use crate::{GeometryRouter, Mesh, Result, TessellationQuality};
use std::cell::RefCell;

/// One host cut's numerical state. Interior mutability is request-owned; no
/// borrow of the effect buffer spans a call into the kernel.
pub(crate) struct Execution {
    pub(crate) tessellation_quality: TessellationQuality,
    effects: RefCell<EffectSet>,
}

/// Lexical ownership of one clipper's kernel evidence: drains the reached
/// failures exactly once on every exit, including an unwind before the
/// ordinary drain point.
pub(crate) struct FailureCapture<'a> {
    execution: &'a Execution,
    clipper: &'a ClippingProcessor,
    id: u32,
}

impl Drop for FailureCapture<'_> {
    fn drop(&mut self) {
        let failures = self.clipper.take_failures();
        if !failures.is_empty() {
            self.execution.push(Effect::Failures(self.id, failures));
        }
    }
}

impl Execution {
    pub(crate) fn new(tessellation_quality: TessellationQuality) -> Self {
        Self {
            tessellation_quality,
            effects: RefCell::new(EffectSet::default()),
        }
    }

    pub(crate) fn finish(self) -> EffectSet {
        self.effects.into_inner()
    }

    /// Keep everything an accepted speculative child recorded, in order. A
    /// rejected or unwound child is simply dropped.
    pub(crate) fn accept(&self, child: Self) {
        self.effects.borrow_mut().append(child.finish());
    }

    /// The current end of the effect buffer.
    pub(crate) fn mark(&self) -> usize {
        self.effects.borrow().len()
    }

    /// Remove and return the effects recorded since `mark`.
    pub(crate) fn split_off(&self, mark: usize) -> EffectSet {
        self.effects.borrow_mut().split_off(mark)
    }

    /// Drop everything recorded since `mark`, then restore `kept` after it.
    pub(crate) fn restore(&self, mark: usize, kept: EffectSet) {
        let mut effects = self.effects.borrow_mut();
        effects.truncate(mark);
        effects.append(kept);
    }

    pub(crate) fn capture_failures<'a>(
        &'a self,
        clipper: &'a ClippingProcessor,
        id: u32,
    ) -> FailureCapture<'a> {
        FailureCapture {
            execution: self,
            clipper,
            id,
        }
    }

    fn push(&self, effect: Effect) {
        self.effects.borrow_mut().push(effect);
    }

    pub(crate) fn record_rect_fast(&self, stats: &crate::rect_fast::RectFastStats) {
        self.push(Effect::Rect(*stats));
    }

    pub(crate) fn record_void_consumed_host(&self, id: u32) {
        self.push(Effect::Consumed(id));
    }

    pub(crate) fn record_host_cut_effect(
        &self,
        id: u32,
        before: usize,
        after: usize,
        rectangles: usize,
        bounds: ((f32, f32, f32), (f32, f32, f32)),
    ) {
        self.push(Effect::Cut {
            id,
            before,
            after,
            rectangles,
            bounds,
        });
    }
}

/// A completed numerical cut with its unpublished diagnostics and telemetry.
pub(crate) struct NumericalOutcome {
    result: std::thread::Result<Mesh>,
    effects: EffectSet,
    telemetry: crate::telemetry_transaction::EffectSet,
}

impl NumericalOutcome {
    /// Accept the geometry and publish once. A stop reached by the cut keeps
    /// only its kernel failures; an unwind publishes what was reached, then
    /// resumes the original panic payload.
    pub(crate) fn publish(self, router: &GeometryRouter) -> Result<Mesh> {
        match self.result {
            Ok(mesh) => match crate::resource::check_current() {
                Ok(()) => {
                    self.effects.publish(router);
                    self.telemetry.commit();
                    Ok(mesh)
                }
                Err(stop) => {
                    self.effects.publish_failures(router);
                    Err(stop.into())
                }
            },
            Err(panic) => {
                self.effects.publish(router);
                self.telemetry.commit();
                std::panic::resume_unwind(panic)
            }
        }
    }
}

/// Cut one host part by a classified context.
pub(crate) fn execute(
    mesh: Mesh,
    context: &VoidContext,
    id: u32,
    quality: TessellationQuality,
) -> NumericalOutcome {
    let execution = Execution::new(quality);
    let (result, telemetry) = crate::telemetry_transaction::capture(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            execution.apply_void_context(mesh, context, id)
        }))
    });
    NumericalOutcome {
        result,
        effects: execution.finish(),
        telemetry,
    }
}

#[cfg(test)]
#[path = "execute_tests.rs"]
mod tests;
