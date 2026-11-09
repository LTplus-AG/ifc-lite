// SPDX-License-Identifier: MPL-2.0
//! Logical exhaustion stops siblings but closes entered sources normally, so
//! completed prefix meshes receive every enclosing transform, innermost first.
use super::drop::{report_drop, DropReason};
use super::{Action, Event, MappingControl, MappingValue, Sink, Template};
use crate::program::mapping_budget::LogicalRefusal;
use crate::GeometryRouter;

impl MappingControl<'_> {
    #[inline]
    pub(in crate::program) fn accept(
        &mut self,
        reply: super::MappingReply,
        router: &GeometryRouter,
    ) {
        self.accept_with_product(reply, router, || None);
    }

    /// Resolve attribution only for a refusal. Product controls already own
    /// this reference; successful replies carry no extra identity or state.
    #[inline(always)]
    pub(in crate::program) fn accept_with_product<'p>(
        &mut self,
        reply: super::MappingReply,
        router: &GeometryRouter,
        product: impl FnOnce() -> Option<&'p ifc_lite_core::DecodedEntity>,
    ) {
        match reply {
            MappingValue::Refused { item_id, refusal, budget } => {
                self.budget = budget;
                self.stop_logical(item_id, &refusal, router, product());
            }
            reply => self.accept_progress(reply, router),
        }
    }

    #[cold]
    #[inline(never)]
    pub(super) fn stop_logical(
        &mut self,
        item_id: u32,
        refusal: &LogicalRefusal,
        router: &GeometryRouter,
        product: Option<&ifc_lite_core::DecodedEntity>,
    ) {
        // Styled admission may own a provisional template before Items. Roll
        // that claim back without attributing the refusal to its child policy.
        if let Action::StyledItems(pending) = std::mem::replace(&mut self.action, Action::Taken) {
            if let Some(Template { claim }) = pending.template {
                router.rollback_logical_template(pending.source_id, claim);
            }
        }
        let (budget, limit, reached) = refusal.details();
        let error = match GeometryRouter::recoverable_source_error(refusal.to_error(item_id)) {
            Ok(error) => error,
            Err(stop) => {
                let event = self.fail_level(stop, router);
                self.reduce(event, router);
                return;
            }
        };
        if self.retained.is_some() {
            // Retained transactions return this refusal to their caller; their
            // model-lifetime router must not accumulate an unread duplicate log.
            self.action = Action::Complete(Err(error));
            return;
        }
        // Keep the source's reporting policy, including CATIA's blank-type
        // FootPrint suppression. Product admission reports independently.
        if self.levels.last().is_none_or(|parent| parent.policy) {
            let product = product.or_else(|| self.rep_map.as_ref().and_then(super::TypeMapRoot::product));
            router.record_budget_refusal(item_id, budget, limit, reached, product);
        }
        self.logical_stopped = true;
        let Some(parent) = self.levels.last() else {
            // Root refusal is observable as an error, never a counted drop.
            self.complete(Err(error));
            return;
        };
        report_drop(DropReason::LogicalStop { item_id }, &error, parent.policy, router);
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
