// SPDX-License-Identifier: MPL-2.0
//! Logical exhaustion stops siblings but closes entered sources normally, so
//! completed prefix meshes receive every enclosing transform, innermost first.
use super::{Action, Event, MappingControl, Sink, Template};
use crate::program::mapping_budget::LogicalRefusal;
use crate::GeometryRouter;
use ifc_lite_core::IfcType;

impl MappingControl<'_> {
    pub(super) fn stop_logical(&mut self, item_id: u32, refusal: LogicalRefusal, router: &GeometryRouter) {
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
        self.logical_stopped = true;
        let Some(parent) = self.levels.last() else {
            // Root refusal is observable as an error, never a counted drop.
            self.complete(Err(error));
            return;
        };
        {
            let _policy = router.enter_unsupported_policy(parent.policy);
            router.record_unsupported_item(IfcType::IfcMappedItem);
        }
        crate::diag::diag_debug!(
            { item_id = item_id, error = %error, "skipping nested IfcMappedItem" }
            else {
                #[cfg(debug_assertions)]
                eprintln!("[ifc-lite] Skipping nested IfcMappedItem #{}: {}", item_id, error);
            }
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
