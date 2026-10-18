// SPDX-License-Identifier: MPL-2.0
//! Ordered, consuming publication. Speculative children own a narrower buffer.
use crate::rect_fast::RectFastStats;
use crate::{BoolFailure, GeometryRouter};

type Bounds = ((f32, f32, f32), (f32, f32, f32));
#[derive(Clone)]
pub(crate) enum Effect {
    Rect(RectFastStats),
    FailureSummary(u32, Vec<BoolFailure>),
    Failures(u32, Vec<BoolFailure>),
    Consumed(u32),
    Cut {
        id: u32,
        before: usize,
        after: usize,
        rectangles: usize,
        bounds: Bounds,
    },
}
#[derive(Clone, Default)]
pub(crate) struct EffectSet(Vec<Effect>);
impl EffectSet {
    pub(crate) fn push(&mut self, effect: Effect) {
        self.0.push(effect);
    }
    pub(crate) fn append(&mut self, mut child: Self) {
        self.0.append(&mut child.0);
    }
    /// Reached root numerical failures remain evidence when geometry cannot be
    /// accepted. Speculative children reach this set only after acceptance.
    pub(crate) fn publish_failures(mut self, router: &GeometryRouter) {
        self.0.retain(|effect| matches!(effect,
            Effect::FailureSummary(..) | Effect::Failures(..)));
        self.publish(router);
    }
    pub(crate) fn publish(self, router: &GeometryRouter) {
        for effect in self.0 {
            match effect {
                Effect::Rect(stats) => router.record_rect_fast(&stats),
                Effect::FailureSummary(id, failures) => {
                    router.record_host_failure_summary(id, &failures)
                }
                Effect::Failures(id, failures) => router.record_csg_failures(id, failures),
                Effect::Consumed(id) => router.record_void_consumed_host(id),
                Effect::Cut {
                    id,
                    before,
                    after,
                    rectangles,
                    bounds,
                } => router.record_host_cut_effect(id, before, after, rectangles, bounds),
            }
        }
    }
}
