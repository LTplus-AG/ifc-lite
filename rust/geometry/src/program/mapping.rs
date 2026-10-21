// SPDX-License-Identifier: MPL-2.0
//! Mapped-source control for one reached `IfcMappedItem` occurrence, or for
//! the shared registry entry of one don't-bake source (#1623).
//!
//! The walk is owned state, not recursion: the active source path is a stack
//! of [`Level`]s, innermost last. Source admission (mapping source, transform,
//! cache entry, representation items) and each plain item's selected
//! processor run as source steps; each item's ordered merge into its source's
//! accumulator, closing a source into frame parts (#6446) and placing an
//! occurrence by its mapping are numerical steps. Router effects (dropped-item
//! records, cache publication, source claims) apply only when a reply is
//! accepted.
//!
//! A nested mapped item is entered as one more level; its placed parts merge
//! into the parent like an item's mesh. A nested failure is a recorded drop
//! that marks every enclosing source truncated, so none of them is published
//! model-wide short of its geometry; a program stop is terminal for the whole
//! walk and unwinds through each level's recovery check in turn.
use super::inner::{ProgramError, ProgramStage};
use super::item::{ItemControl, ItemStep};
use crate::router::frame_parts::SourceParts;
use crate::router::mapped_item::MappedOccurrence;
use crate::{GeometryRouter, Mesh, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use std::sync::Arc;

/// One source on the active mapping path.
struct Level {
    /// The mapped item that reached this source; the path's cycle check reads
    /// these. A shared registry root has none and never enters a nested item.
    item_id: u32,
    source_id: u32,
    /// The scaled `MappingTarget` over `MappingOrigin`.
    transform: Option<Matrix4<f64>>,
    items: std::vec::IntoIter<DecodedEntity>,
    parts: SourceParts,
    /// Whether drops beneath this source are recorded: decided once per
    /// source by [`GeometryRouter::claim_unsupported_source`].
    policy: bool,
    /// A bound cut this source's merge short (a dropped or truncated nested
    /// item), so it must not be published model-wide.
    truncated: bool,
}

enum Entering<'a> {
    Root(&'a DecodedEntity),
    Nested(DecodedEntity),
}

impl Entering<'_> {
    fn item(&self) -> &DecodedEntity {
        match self {
            Self::Root(item) => item,
            Self::Nested(item) => item,
        }
    }
}

enum Merging {
    /// A plain item's mesh, still in the model RTC frame if it was rebased.
    Item(Mesh),
    /// A nested source's placed frame parts.
    Nested(Vec<Mesh>),
}

enum Placing {
    Cached(Arc<Mesh>),
    Walked(Vec<Mesh>),
}

struct Place {
    parts: Placing,
    item_id: u32,
    source_id: u32,
    transform: Option<Matrix4<f64>>,
    truncated: bool,
}

enum Action<'a> {
    /// Resolve a mapped item's source, transform and cache entry.
    Enter(Entering<'a>),
    /// Resolve the shared registry source's items.
    SharedItems,
    /// One plain source item through the common item controller.
    Child(DecodedEntity, ItemControl),
    /// Merge into the innermost source's accumulator, in item order.
    Merge(Merging),
    /// Close the innermost source's accumulator into frame parts.
    Finish,
    /// Place an occurrence's source-coords parts by its mapping.
    Place(Place),
    Complete(Result<Vec<Mesh>>),
    /// Moved out by an executing or accepting step.
    Taken,
}

pub(super) enum MappingReply {
    Entered { item_id: u32, value: Result<(u32, MappedOccurrence)> },
    SharedItems(Vec<DecodedEntity>),
    Child(ItemStep),
    Merged(SourceParts),
    Finished(Result<Vec<Mesh>>),
    Placed { item_id: u32, truncated: bool, value: Result<Vec<Mesh>> },
}

impl MappingReply {
    pub(super) fn tag(&self) -> u8 {
        match self {
            Self::Entered { .. } => 0,
            Self::SharedItems(_) => 1,
            Self::Child(_) => 2,
            Self::Merged(_) => 3,
            Self::Finished(_) => 4,
            Self::Placed { .. } => 5,
        }
    }
}

/// What the accept-side reduction does next. A loop over these, not mutual
/// recursion, so a long run of dropped items costs no stack.
enum Event {
    /// Pick the innermost source's next item.
    Advance,
    /// Hand a finished (or failed) level's result to its parent, or complete.
    Deliver { item_id: u32, truncated: bool, value: Result<Vec<Mesh>> },
}

pub(super) struct MappingControl<'a> {
    /// The shared registry walk publishes its source and places nothing.
    shared: Option<(&'a DecodedEntity, u32)>,
    levels: Vec<Level>,
    action: Action<'a>,
}

impl<'a> MappingControl<'a> {
    pub(super) fn occurrence(item: &'a DecodedEntity) -> Self {
        Self { shared: None, levels: Vec::new(), action: Action::Enter(Entering::Root(item)) }
    }

    pub(super) fn shared_source(representation: &'a DecodedEntity, source_id: u32) -> Self {
        Self { shared: Some((representation, source_id)), levels: Vec::new(), action: Action::SharedItems }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        Ok(match &self.action {
            Action::Enter(_) | Action::SharedItems => Some(ProgramStage::Source),
            Action::Child(_, control) => return control.stage(),
            Action::Merge(_) | Action::Finish | Action::Place(_) => Some(ProgramStage::Numerical),
            Action::Complete(_) => None,
            Action::Taken => return Err(ProgramError::Outstanding),
        })
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<MappingReply, ProgramError> {
        if let Action::Child(item, control) = &mut self.action {
            return control.execute(item, router, decoder).map(MappingReply::Child);
        }
        Ok(match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Enter(entering) => {
                let item = entering.item();
                let value = router.admit_mapped_occurrence(item, decoder);
                MappingReply::Entered { item_id: item.id, value }
            }
            Action::SharedItems => {
                let (representation, _) = self.shared.ok_or(ProgramError::StaleRequest)?;
                MappingReply::SharedItems(GeometryRouter::shared_source_items(representation, decoder))
            }
            Action::Merge(merging) => {
                let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
                let mut parts = std::mem::take(&mut level.parts);
                match merging {
                    Merging::Item(mut mesh) => {
                        router.keep_rebase_in_origin(&mut mesh);
                        parts.merge(&mesh);
                    }
                    Merging::Nested(nested) => nested.iter().for_each(|part| parts.merge(part)),
                }
                MappingReply::Merged(parts)
            }
            Action::Finish => {
                let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
                MappingReply::Finished(std::mem::take(&mut level.parts).into_parts())
            }
            Action::Place(Place { parts, item_id, source_id, transform, truncated }) => {
                let value = match parts {
                    Placing::Cached(mesh) => router.clone_cached_mesh(&mesh).map(|mesh| vec![mesh]),
                    Placing::Walked(parts) => Ok(parts),
                };
                let value = value.map(|mut parts| {
                    router.place_mapped_parts(source_id, &mut parts, transform.as_ref());
                    parts
                });
                MappingReply::Placed { item_id, truncated, value }
            }
            other => {
                self.action = other;
                return Err(ProgramError::StaleRequest);
            }
        })
    }

    pub(super) fn accept(&mut self, reply: MappingReply, router: &GeometryRouter) {
        let event = match (std::mem::replace(&mut self.action, Action::Taken), reply) {
            (Action::Taken, MappingReply::Entered { item_id, value }) => match value {
                Err(error) => Event::Deliver { item_id, truncated: false, value: Err(error) },
                Ok((source_id, MappedOccurrence::Cached { mesh, transform })) => {
                    let parts = Placing::Cached(mesh);
                    self.action = Action::Place(Place { parts, item_id, source_id, transform, truncated: false });
                    return;
                }
                Ok((source_id, MappedOccurrence::Source { representation, items, transform })) => {
                    self.enter_source(item_id, source_id, transform, &representation, items, router);
                    Event::Advance
                }
            },
            (Action::Taken, MappingReply::SharedItems(items)) => match self.shared {
                Some((representation, source_id)) => {
                    self.enter_source(u32::MAX, source_id, None, representation, items, router);
                    Event::Advance
                }
                None => return,
            },
            (Action::Child(item, mut control), MappingReply::Child(step)) => {
                let policy = self.levels.last().is_none_or(|level| level.policy);
                {
                    let _policy = router.enter_unsupported_policy(policy);
                    control.accept(step, router);
                }
                match control.take_result() {
                    None => {
                        self.action = Action::Child(item, control);
                        return;
                    }
                    Some(Ok(mesh)) => {
                        self.action = Action::Merge(Merging::Item(mesh));
                        return;
                    }
                    Some(Err(error)) => match self.drop_item(&item, error, router) {
                        Ok(()) => Event::Advance,
                        Err(stop) => self.fail_level(stop),
                    },
                }
            }
            (Action::Taken, MappingReply::Merged(parts)) => match self.levels.last_mut() {
                Some(level) => {
                    level.parts = parts;
                    Event::Advance
                }
                None => return,
            },
            (Action::Taken, MappingReply::Finished(value)) => match self.levels.pop() {
                Some(level) => self.finish_level(level, value, router),
                None => return,
            },
            (Action::Taken, MappingReply::Placed { item_id, truncated, value }) => {
                Event::Deliver { item_id, truncated, value }
            }
            // Payload validation precedes acceptance; a mismatch cannot reach here.
            (action, _) => {
                self.action = action;
                return;
            }
        };
        self.reduce(event, router);
    }

    pub(super) fn take_result(&mut self) -> Option<Result<Vec<Mesh>>> {
        match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Complete(result) => Some(result),
            other => {
                self.action = other;
                None
            }
        }
    }
}

#[path = "mapping_reduce.rs"]
mod reduce;
