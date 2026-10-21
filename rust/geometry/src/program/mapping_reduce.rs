// SPDX-License-Identifier: MPL-2.0
//! The mapping controller's accept-side reduction: owned control only. It
//! opens and closes source levels, applies their router effects (source and
//! template claims, cache publication, dropped-item records) and selects the
//! next step, as the historical recursive walks did at the same points.
use super::{Action, Event, Level, MappingControl, Merging, Pending, Place, Placeholder, Placing, Reached,
    Sink, Template, Walk};
use crate::router::frame_parts::SourceParts;
use crate::router::mapped_item::StyledSource;
use crate::{Error, GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, IfcType, MAX_MAPPED_ITEM_DEPTH};
use nalgebra::Matrix4;

impl MappingControl<'_> {
    /// Open a merged, shared or type-map source walk. Its drop policy is
    /// claimed here, once per source, after its items resolved: the point the
    /// historical walk entered it.
    #[allow(clippy::too_many_arguments)] // one level's admitted parts
    pub(super) fn enter_source(&mut self, item_id: u32, source_id: u32, transform: Option<Matrix4<f64>>,
        representation: &DecodedEntity, items: Vec<DecodedEntity>, sink: Sink, router: &GeometryRouter) {
        let policy = router.claim_unsupported_source(source_id, representation);
        self.levels.push(Level {
            item_id,
            source_id,
            transform,
            items: items.into_iter(),
            parts: SourceParts::default(),
            policy,
            truncated: false,
            sink,
        });
    }

    /// A closed merged source: an occurrence publishes it to its cache before
    /// placing it; the shared registry walk publishes it, then pushes the
    /// placeholder that waited on it or completes.
    pub(super) fn finish_level(&mut self, level: Level, value: Result<Vec<Mesh>>, router: &GeometryRouter) -> Event {
        let Level { item_id, source_id, transform, truncated, sink, .. } = level;
        if let Sink::Shared(placeholder) = sink {
            // A refused merge is a typed terminal, not a skipped registration.
            let value = match value {
                Ok(_) if self.logical_stopped => Ok(()),
                Ok(parts) => router.publish_shared_mapped_source(source_id, parts),
                Err(error @ Error::ProgramStopped(_)) => Err(error),
                Err(_) => Ok(()),
            };
            self.action = match (value, placeholder) {
                (Ok(()), Some(placeholder)) => Action::Placeholder(placeholder),
                (value, _) => Action::Complete(value.map(|()| super::MappingOutput::Parts(Vec::new()))),
            };
            return Event::Advance;
        }
        let published = value.and_then(|parts| {
            if !self.logical_stopped {
                router.publish_mapped_source(source_id, &parts, truncated)?;
            }
            Ok(parts)
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

    /// The innermost level failed with `error`: close it, rolling back its
    /// provisional template claim, and hand the failure to its parent, as the
    /// historical walk returned it to its caller.
    pub(super) fn fail_level(&mut self, error: Error, router: &GeometryRouter) -> Event {
        let item_id = match self.levels.pop() {
            Some(level) => {
                if let Sink::Styled { template: Some(Template { claim: Some(claim) }), .. } = level.sink {
                    router.settle_template(claim, false);
                }
                level.item_id
            }
            None => u32::MAX,
        };
        Event::Deliver { item_id, truncated: false, value: Err(error) }
    }

    /// Record a failed plain item as dropped beneath the innermost source, or
    /// return the program stop it carried.
    pub(super) fn drop_item(&self, item: &DecodedEntity, error: Error, router: &GeometryRouter) -> Result<()> {
        let policy = self.levels.last().is_none_or(|level| level.policy);
        let walk = match self.levels.last().map(|level| &level.sink) {
            Some(Sink::Shared(_)) => "shared-source",
            Some(Sink::TypeMap) => "representation-map",
            Some(Sink::Styled { .. }) | None if self.walk == Walk::Styled => "styled-source",
            _ => "mapped-source",
        };
        Self::record_drop(item, error, policy, walk, router)
    }

    /// A styled walk's failed root plain item (`GeometryProgram::styled_item`):
    /// recorded like the walk's own root drop, or the program stop it carried.
    #[cold]
    #[inline(never)]
    pub(in crate::program) fn drop_styled_root(item: &DecodedEntity, error: Error, router: &GeometryRouter)
        -> Result<()> {
        Self::record_drop(item, error, true, "styled-source", router)
    }

    fn record_drop(item: &DecodedEntity, error: Error, policy: bool, walk: &'static str, router: &GeometryRouter)
        -> Result<()> {
        let _e = GeometryRouter::recoverable_source_error(error)?;
        let _policy = router.enter_unsupported_policy(policy);
        router.record_unsupported_item(item.ifc_type.clone());
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
            // A styled walk's root plain item is its only item.
            let value = match self.walk {
                Walk::Styled => Ok(Vec::new()),
                _ => Err(Error::geometry("mapped source walk lost its source")),
            };
            self.complete(value);
            return None;
        };
        let Some(item) = level.items.next() else {
            self.action = match level.sink {
                Sink::TypeMap => Action::Origin,
                _ => Action::Finish,
            };
            return None;
        };
        match level.sink {
            Sink::Styled { .. } => return self.next_styled(item, router),
            Sink::TypeMap if item.ifc_type != IfcType::IfcMappedItem
                && self.textures.is_some_and(|index| index.contains_key(&item.id)) => {
                self.action = Action::Texture(Reached::Nested(item));
                return None;
            }
            Sink::Shared(ref mut placeholder) if item.ifc_type == IfcType::IfcMappedItem => {
                // Unreachable through the only caller, which admits exactly one
                // non-mapped item (`mapped_source_single_item`). Publishing would
                // register a source short of its nested geometry model-wide, so
                // the registration is withheld. The source claim stands: a later
                // complete walk of it records nothing.
                let placeholder = placeholder.take();
                self.levels.clear();
                self.action = match placeholder {
                    Some(placeholder) => Action::Placeholder(placeholder),
                    None => Action::Complete(Ok(super::MappingOutput::Parts(Vec::new()))),
                };
                return None;
            }
            _ => {}
        }
        if item.ifc_type == IfcType::IfcMappedItem {
            // A type map's own items start a fresh path: its nested mapped
            // item is a root occurrence, as when it was walked on its own.
            let depth = self.levels.len() - usize::from(self.walk == Walk::TypeMap);
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
            self.action = Action::Enter(Reached::Nested(item));
            return None;
        }
        self.select_plain(Reached::Nested(item), router)
    }

    /// Only entering another mapped level consumes depth. Plain and textured
    /// leaves under exactly 32 mapped levels remain reachable (#7887).
    fn next_styled(&mut self, item: DecodedEntity, router: &GeometryRouter) -> Option<Event> {
        if item.ifc_type != IfcType::IfcMappedItem {
            if self.textures.is_some_and(|index| index.contains_key(&item.id)) {
                self.action = Action::Texture(Reached::Nested(item));
                return None;
            }
            return self.select_plain(Reached::Nested(item), router);
        }
        let error = if self.levels.len() >= MAX_MAPPED_ITEM_DEPTH as usize {
            Error::geometry(format!(
                "MappedItem nesting exceeded maximum depth of {} at #{}",
                MAX_MAPPED_ITEM_DEPTH, item.id
            ))
        } else if self.levels.iter().any(|level| level.item_id == item.id) {
            Error::geometry(format!("Detected cyclic IfcMappedItem reference at #{}", item.id))
        } else {
            self.action = Action::EnterStyled(Reached::Nested(item));
            return None;
        };
        Some(self.drop_or_fail(&item, error, router))
    }

    /// A styled mapped item admitted: decide the don't-bake template, then
    /// either wait on the shared registry and push the placeholder, or claim
    /// the source and resolve its items.
    pub(super) fn enter_styled(&mut self, item_id: u32, value: Result<StyledSource>,
        router: &GeometryRouter) -> Event {
        let StyledSource { source_id, representation, transform, solid_id } = match value {
            Ok(source) => source,
            Err(error) => return Event::Deliver { item_id, truncated: false, value: Err(error) },
        };
        let template = match solid_id {
            None => None,
            Some(solid_id) => match router.claim_template(item_id, source_id) {
                Err(error) => return Event::Deliver { item_id, truncated: false, value: Err(error) },
                Ok((true, claim)) => Some(Template { claim }),
                Ok((false, _)) => {
                    // NON-template occurrence: don't-bake. The shared registry
                    // first holds the source geometry (meshed once model-wide),
                    // so the finalize can recover it even if the template never
                    // materialized; then the instance-only placeholder.
                    let placeholder = Placeholder { solid_id, source_id, transform };
                    self.action = match router.shared_mapped_source_needed(source_id) {
                        Err(error) => return Event::Deliver { item_id, truncated: false, value: Err(error) },
                        Ok(true) => Action::SharedItems(Reached::Nested(representation), source_id, Some(placeholder)),
                        Ok(false) => Action::Placeholder(placeholder),
                    };
                    return Event::Advance;
                }
            },
        };
        // One drop policy for this source's walk, claimed before its items
        // resolve. Body-only, and once per source rather than per occurrence;
        // see `GeometryRouter::claim_unsupported_source`.
        let policy = router.claim_unsupported_source(source_id, &representation);
        self.action = Action::StyledItems(Pending { item_id, source_id, representation, transform, policy, template });
        Event::Advance
    }

    pub(super) fn open_styled(&mut self, pending: Pending, items: Result<Vec<DecodedEntity>>,
        router: &GeometryRouter) -> Event {
        let Pending { item_id, source_id, transform, policy, template, .. } = pending;
        let items = match items {
            Ok(items) => items,
            Err(error) => {
                if let Some(Template { claim: Some(claim) }) = template {
                    router.settle_template(claim, false);
                }
                return Event::Deliver { item_id, truncated: false, value: Err(error) };
            }
        };
        let start = self.meshes.len();
        self.levels.push(Level {
            item_id,
            source_id,
            transform,
            items: items.into_iter(),
            parts: SourceParts::default(),
            policy,
            truncated: false,
            sink: Sink::Styled { start, template },
        });
        Event::Advance
    }

    /// A baked styled source: keep its template claim if it materialized
    /// geometry, then hand control back to its parent.
    pub(super) fn close_styled(&mut self, router: &GeometryRouter) -> Event {
        let Some(level) = self.levels.pop() else { return Event::Advance };
        if let Sink::Styled { start, template: Some(Template { claim: Some(claim) }) } = level.sink {
            router.settle_template(claim, self.meshes.len() > start);
        }
        Event::Deliver { item_id: level.item_id, truncated: false, value: Ok(Vec::new()) }
    }

    /// Hand a level's result to its parent source, or complete the walk.
    fn deliver(&mut self, item_id: u32, truncated: bool, value: Result<Vec<Mesh>>,
        router: &GeometryRouter) -> Option<Event> {
        let styled = self.walk == Walk::Styled;
        let Some(parent) = self.levels.last_mut() else {
            self.complete(value);
            return None;
        };
        let error = match value {
            // A styled source's sub-meshes are already in the walk's collection.
            Ok(_) if styled => return Some(Event::Advance),
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
                Some(Event::Advance)
            }
            // A stop is terminal: every enclosing level observes it in turn.
            Err(stop) => Some(self.fail_level(stop, router)),
        }
    }
}

#[cfg(test)]
#[path = "mapping_depth_tests.rs"]
mod depth_tests;
