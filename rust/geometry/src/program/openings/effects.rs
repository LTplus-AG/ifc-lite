// SPDX-License-Identifier: MPL-2.0
//! Ordered, consuming publication of one host cut's diagnostics. A
//! speculative child owns its own set and reaches its parent only on accept.
use crate::rect_fast::RectFastStats;
use crate::{BoolFailure, GeometryRouter};

type Bounds = ((f32, f32, f32), (f32, f32, f32));

pub(crate) enum Effect {
    Rect(RectFastStats),
    /// One drained kernel batch: the host summary, then the failures.
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

#[derive(Default)]
pub(crate) struct EffectSet(Vec<Effect>);

impl EffectSet {
    pub(crate) fn push(&mut self, effect: Effect) {
        self.0.push(effect);
    }

    pub(crate) fn append(&mut self, mut child: Self) {
        self.0.append(&mut child.0);
    }

    pub(crate) fn len(&self) -> usize {
        self.0.len()
    }

    /// The effects recorded after `mark`, removed from this set.
    pub(crate) fn split_off(&mut self, mark: usize) -> Self {
        Self(self.0.split_off(mark.min(self.0.len())))
    }

    pub(crate) fn truncate(&mut self, mark: usize) {
        self.0.truncate(mark);
    }

    /// Reached kernel failures stay evidence when the geometry cannot be
    /// accepted; every other effect of the rejected host is dropped.
    pub(crate) fn publish_failures(mut self, router: &GeometryRouter) {
        self.0
            .retain(|effect| matches!(effect, Effect::Failures(..)));
        self.publish(router);
    }

    pub(crate) fn publish(self, router: &GeometryRouter) {
        for effect in self.0 {
            match effect {
                Effect::Rect(stats) => router.record_rect_fast(&stats),
                Effect::Failures(id, failures) => {
                    router.record_host_failure_summary(id, &failures);
                    router.record_csg_failures(id, failures);
                }
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
