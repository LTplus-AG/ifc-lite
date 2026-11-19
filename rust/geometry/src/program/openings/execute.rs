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

/// Cut one host part by a classified context. The one place that decides a
/// host was consumed: see the rule inside.
pub(crate) fn execute(
    mesh: Mesh,
    context: &VoidContext,
    id: u32,
    quality: TessellationQuality,
) -> NumericalOutcome {
    let execution = Execution::new(quality);
    let (result, telemetry) = crate::telemetry_transaction::capture(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let had_triangles = mesh.triangle_count() > 0;
            let measure = (context.rect_opening_count() > 0)
                .then(|| CutMeasure::new(&mesh));
            let cut = execution.apply_void_context(mesh, context, id);
            if let Some(measure) = measure.filter(|_| execution.effects.borrow().attempted_rectangular_cut()) {
                let unchanged = measure.is_some_and(|before| before.matches(&cut));
                execution.push(Effect::MeasuredRectangularCut(id, unchanged));
            }
            // Every path that can empty a host (analytic rectangle, 2D,
            // prism, engulf) does so only when the openings' union covers
            // it; the kernel paths refuse an empty result. So an empty cut
            // of a host that had triangles is the consumed answer, and the
            // element keeps it instead of re-rendering the host uncut.
            if had_triangles && cut.triangle_count() == 0 {
                execution.record_void_consumed_host(id);
            }
            cut
        }))
    });
    NumericalOutcome {
        result,
        effects: execution.finish(),
        telemetry,
    }
}

struct CutMeasure {
    area: f64,
    volume: f64,
    reference: [f64; 3],
    origin: [f64; 3],
}

impl CutMeasure {
    fn new(mesh: &Mesh) -> Option<Self> {
        use crate::mesh_check::{signed_volume_about, surface_area, volume_reference};
        let area = surface_area(mesh)?;
        let reference = volume_reference(mesh);
        let volume = signed_volume_about(mesh, &reference).abs();
        (area > 0.0 && volume.is_finite()).then_some(Self {
            area, volume, reference, origin: mesh.origin,
        })
    }

    fn matches(&self, mesh: &Mesh) -> bool {
        use crate::mesh_check::{signed_volume_about, surface_area};
        // Allow small geometric changes from placement and cut cleanup.
        const RELATIVE_TOLERANCE: f64 = 1.0e-3;
        let within_tolerance = |before: f64, after: f64| {
            (before - after).abs() <= before * RELATIVE_TOLERANCE
        };
        let Some(area) = surface_area(mesh) else { return false };
        if !within_tolerance(self.area, area) {
            return false;
        }
        // Reuse the same world reference in the result's frame. This keeps the
        // contribution of an untouched open face stable if the bounds shrink.
        let reference = std::array::from_fn(|axis| {
            self.reference[axis] + (self.origin[axis] - mesh.origin[axis])
        });
        within_tolerance(self.volume, signed_volume_about(mesh, &reference).abs())
    }
}

#[cfg(test)]
#[path = "execute_tests.rs"]
mod tests;
