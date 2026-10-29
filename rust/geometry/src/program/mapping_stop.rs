// SPDX-License-Identifier: MPL-2.0
//! Logical exhaustion stops siblings but closes entered sources normally, so
//! completed prefix meshes receive every enclosing transform, innermost first.
use super::drop::{report_drop, DropReason};
use super::{Action, Event, MappingControl, Sink, Template};
use crate::program::mapping_budget::LogicalRefusal;
use crate::GeometryRouter;

impl MappingControl<'_> {
    pub(super) fn stop_logical(
        &mut self,
        item_id: u32,
        refusal: LogicalRefusal,
        router: &GeometryRouter,
    ) {
        // Styled admission may own a provisional template before Items. Roll
        // that claim back without attributing the refusal to its child policy.
        if let Action::StyledItems(pending) = std::mem::replace(&mut self.action, Action::Taken) {
            if let Some(Template { claim }) = pending.template {
                router.rollback_logical_template(pending.source_id, claim);
            }
        }
        let error = match GeometryRouter::recoverable_source_error(refusal.into_error(item_id)) {
            Ok(error) => error,
            Err(stop) => {
                let event = self.fail_level(stop, router);
                self.reduce(event, router);
                return;
            }
        };
        if self.retained.is_some() {
            self.action = Action::Complete(Err(error));
            return;
        }
        self.logical_stopped = true;
        let Some(parent) = self.levels.last() else {
            // Root refusal is observable as an error, never a counted drop.
            self.complete(Err(error));
            return;
        };
        report_drop(
            DropReason::LogicalStop { item_id },
            &error,
            parent.policy,
            router,
        );
        for level in &mut self.levels {
            level.truncated = true;
            level.items = Vec::new().into_iter();
            // Never settle a partial template as successfully materialized.
            if let Sink::Styled { template, .. } = &mut level.sink {
                if let Some(Template { claim }) = template.take() {
                    router.rollback_logical_template(level.source_id, claim);
                }
            }
        }
        self.reduce(Event::Advance, router);
    }
}
