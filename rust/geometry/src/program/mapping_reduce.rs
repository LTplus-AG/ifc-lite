// SPDX-License-Identifier: MPL-2.0
//! The mapping controller's accept-side reduction: owned control only. It
//! opens and closes source levels, applies their router effects (source
//! claims, cache publication, dropped-item records) and selects the next
//! step, as the historical recursive walk did at the same points.
use super::{Action, Entering, Event, Level, MappingControl, Merging, Place, Placing};
use crate::router::frame_parts::SourceParts;
use crate::{Error, GeometryRouter, Mesh, Result};
use super::super::item::ItemControl;
use ifc_lite_core::{DecodedEntity, IfcType, MAX_MAPPED_ITEM_DEPTH};
use nalgebra::Matrix4;

impl MappingControl<'_> {
    /// Open a source walk. Its drop policy is claimed here, once per source,
    /// after its items resolved: the point the historical walk entered it.
    pub(super) fn enter_source(&mut self, item_id: u32, source_id: u32, transform: Option<Matrix4<f64>>,
        representation: &DecodedEntity, items: Vec<DecodedEntity>, router: &GeometryRouter) {
        let policy = router.claim_unsupported_source(source_id, representation);
        self.levels.push(Level {
            item_id,
            source_id,
            transform,
            items: items.into_iter(),
            parts: SourceParts::default(),
            policy,
            truncated: false,
        });
    }

    /// A closed source: an occurrence publishes it to its cache before placing
    /// it; the shared registry walk publishes it and completes.
    pub(super) fn finish_level(&mut self, level: Level, value: Result<Vec<Mesh>>, router: &GeometryRouter) -> Event {
        let Level { item_id, source_id, transform, truncated, .. } = level;
        if self.shared.is_some() {
            // A refused merge is a typed terminal, not a skipped registration.
            let value = match value {
                Ok(parts) => router.publish_shared_mapped_source(source_id, parts).map(|()| Vec::new()),
                Err(error @ Error::ProgramStopped(_)) => Err(error),
                Err(_) => Ok(Vec::new()),
            };
            self.action = Action::Complete(value);
            return Event::Advance;
        }
        let published = value.and_then(|parts| {
            router.publish_mapped_source(source_id, &parts, truncated).map(|()| parts)
        });
        match published {
            Ok(parts) => {
                let parts = Placing::Walked(parts);
                self.action = Action::Place(Place { parts, item_id, source_id, transform, truncated });
                Event::Advance
            }
            Err(error) => Event::Deliver { item_id, truncated, value: Err(error) },
        }
    }

    /// The innermost level failed with `error`: close it and hand the failure
    /// to its parent, as the historical walk returned it to its caller.
    pub(super) fn fail_level(&mut self, error: Error) -> Event {
        let item_id = self.levels.pop().map_or(u32::MAX, |level| level.item_id);
        Event::Deliver { item_id, truncated: false, value: Err(error) }
    }

    /// Record a failed plain item as dropped beneath the innermost source, or
    /// return the program stop it carried.
    pub(super) fn drop_item(&self, item: &DecodedEntity, error: Error, router: &GeometryRouter) -> Result<()> {
        let _e = GeometryRouter::recoverable_source_error(error)?;
        let policy = self.levels.last().is_none_or(|level| level.policy);
        let _policy = router.enter_unsupported_policy(policy);
        router.record_unsupported_item(item.ifc_type.clone());
        let walk = if self.shared.is_some() { "shared-source" } else { "mapped-source" };
        let _ = walk;
        crate::diag::diag_debug!(
            { item_id = item.id, ifc_type = ?item.ifc_type, walk, error = %_e,
              "skipping unsupported source item" }
            else {
                #[cfg(debug_assertions)]
                eprintln!(
                    "[ifc-lite] Skipping unsupported {walk} item #{} ({:?}): {}",
                    item.id, item.ifc_type, _e
                );
            }
        );
        Ok(())
    }

    pub(super) fn reduce(&mut self, mut event: Event, router: &GeometryRouter) {
        loop {
            event = match event {
                Event::Advance if !matches!(self.action, Action::Taken) => return,
                Event::Advance => match self.next_item(router) {
                    Some(event) => event,
                    None => return,
                },
                Event::Deliver { item_id, truncated, value } => {
                    match self.deliver(item_id, truncated, value, router) {
                        Some(event) => event,
                        None => return,
                    }
                }
            };
        }
    }

    /// Select the innermost source's next item; `None` once an action is set.
    fn next_item(&mut self, router: &GeometryRouter) -> Option<Event> {
        let Some(level) = self.levels.last_mut() else {
            self.action = Action::Complete(Err(Error::geometry("mapped source walk lost its source")));
            return None;
        };
        let Some(item) = level.items.next() else {
            self.action = Action::Finish;
            return None;
        };
        if item.ifc_type == IfcType::IfcMappedItem {
            if self.shared.is_some() {
                // Unreachable through the only caller, which admits exactly one
                // non-mapped item (`mapped_source_single_item`). Publishing would
                // register a source short of its nested geometry model-wide, so
                // the registration is withheld. The source claim stands: a later
                // complete walk of it records nothing.
                self.levels.clear();
                self.action = Action::Complete(Ok(Vec::new()));
                return None;
            }
            let depth = self.levels.len();
            if depth >= MAX_MAPPED_ITEM_DEPTH as usize {
                let error = Error::geometry(format!(
                    "MappedItem nesting exceeded maximum depth of {} at #{}",
                    MAX_MAPPED_ITEM_DEPTH, item.id
                ));
                return Some(Event::Deliver { item_id: item.id, truncated: false, value: Err(error) });
            }
            if self.levels.iter().any(|level| level.item_id == item.id) {
                let error = Error::geometry(format!("Detected cyclic IfcMappedItem reference at #{}", item.id));
                return Some(Event::Deliver { item_id: item.id, truncated: false, value: Err(error) });
            }
            self.action = Action::Enter(Entering::Nested(item));
            return None;
        }
        if router.processor_for(&item.ifc_type).is_none() {
            return Some(match self.drop_item(&item, Error::geometry("no processor"), router) {
                Ok(()) => Event::Advance,
                Err(stop) => self.fail_level(stop),
            });
        }
        self.action = Action::Child(item, ItemControl::new(router.rtc_offset()));
        None
    }

    /// Hand a level's result to its parent source, or complete the walk.
    fn deliver(&mut self, item_id: u32, truncated: bool, value: Result<Vec<Mesh>>,
        router: &GeometryRouter) -> Option<Event> {
        let Some(parent) = self.levels.last_mut() else {
            self.action = Action::Complete(value);
            return None;
        };
        let error = match value {
            Ok(parts) => {
                parent.truncated |= truncated;
                self.action = Action::Merge(Merging::Nested(parts));
                return None;
            }
            Err(error) => error,
        };
        match GeometryRouter::recoverable_source_error(error) {
            Ok(_e) => {
                // The nested source's geometry is gone, so this source is short.
                // Recording `IfcMappedItem`, not the inner type, is deliberate:
                // the nested walk failed before it could attribute anything.
                parent.truncated = true;
                let _policy = router.enter_unsupported_policy(parent.policy);
                router.record_unsupported_item(IfcType::IfcMappedItem);
                crate::diag::diag_debug!(
                    { item_id = item_id, error = %_e, "skipping nested IfcMappedItem" }
                    else {
                        #[cfg(debug_assertions)]
                        eprintln!("[ifc-lite] Skipping nested IfcMappedItem #{}: {}", item_id, _e);
                    }
                );
                let _ = item_id;
                Some(Event::Advance)
            }
            // A stop is terminal: every enclosing level observes it in turn.
            Err(stop) => Some(self.fail_level(stop)),
        }
    }
}
