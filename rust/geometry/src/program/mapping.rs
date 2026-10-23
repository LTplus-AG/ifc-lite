// SPDX-License-Identifier: MPL-2.0
//! Mapped-source control: one reached `IfcMappedItem` occurrence (merged and
//! cached, or styled into per-item sub-meshes), the shared registry entry of
//! one don't-bake source (#1623), or an orphan type's representation map.
//!
//! The walk is owned state, not recursion: the active source path is a stack
//! of [`Level`]s, innermost last, each with the [`Sink`] its items feed.
//! Source admission (mapping source, transform, cache entry, representation
//! items, textured face sets, MappingOrigin) and each plain item's selected
//! processor run as source steps; each item's ordered merge into its source's
//! accumulator, closing a source into frame parts (#6446), baking a styled
//! source's mapping and placing an occurrence are numerical steps. Router
//! effects (dropped-item records, cache publication, source and template
//! claims) apply only when a reply is accepted.
//!
//! A nested mapped item is entered as one more level; its placed parts merge
//! into the parent like an item's mesh, or, styled, its sub-meshes stay in the
//! walk's collection for the parent to bake. A nested failure is a recorded
//! drop; a program stop is terminal for the whole walk and unwinds through
//! each level's recovery check in turn.
use super::inner::{ProgramError, ProgramStage};
use super::inner_cache::{CacheControl, CacheReply};
use super::item::{ItemControl, ItemStep};
use crate::processors::texture::ResolvedTextureMap;
use crate::router::frame_parts::SourceParts;
use crate::router::instancing::TemplateClaim;
use crate::router::mapped_item::{MappedOccurrence, StyledSource};
use crate::router::textured::{TexturedPart, TypeParts};
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;
use std::sync::Arc;

type Textures<'a> = Option<&'a FxHashMap<u32, ResolvedTextureMap>>;

/// The walk a control drives, fixed at construction.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Walk {
    Occurrence,
    /// Only the shared-walk tests drive it alone; production reaches a
    /// shared level from a styled placeholder.
    #[cfg(test)]
    Shared,
    Styled,
    TypeMap,
}

/// What a source level's items feed, and how the level closes.
enum Sink {
    /// A mapped occurrence's source: published to its cache, then placed.
    Occurrence,
    /// The shared registry source: published, then the don't-bake
    /// placeholder that waited on it, if any.
    Shared(Option<Placeholder>),
    /// A type's representation map: its MappingOrigin, then its parts.
    TypeMap,
    /// A styled source: the sub-meshes its items added from `start`, baked
    /// by its mapping; re-tagged when it is the don't-bake template.
    Styled { start: usize, template: Option<Template> },
}

/// The don't-bake TEMPLATE occurrence, with its provisional claim if any.
pub(super) struct Template {
    claim: Option<TemplateClaim>,
}

/// A don't-bake occurrence's instance-only placeholder.
pub(super) struct Placeholder {
    solid_id: u32,
    source_id: u32,
    transform: Option<Matrix4<f64>>,
}

/// One source on the active mapping path.
struct Level {
    /// The mapped item that reached this source; the path's cycle check reads
    /// these. A shared registry or type-map root has none.
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
    sink: Sink,
}

/// A reached item: the walk's borrowed root, or one owned by its source
/// (or by the product walk that reached it).
pub(super) enum Reached<'a> {
    Root(&'a DecodedEntity),
    Nested(DecodedEntity),
}

impl Reached<'_> {
    fn item(&self) -> &DecodedEntity {
        match self {
            Self::Root(item) => item,
            Self::Nested(item) => item,
        }
    }
}

/// A styled source admitted and claimed, waiting for its items.
struct Pending {
    item_id: u32,
    source_id: u32,
    representation: DecodedEntity,
    transform: Option<Matrix4<f64>>,
    policy: bool,
    template: Option<Template>,
}

enum ChildControl {
    /// The selected processor alone (merged and type-map sources).
    Item(ItemControl),
    /// Wrapped by the content-dedup and hash caches (styled sources).
    Cache(CacheControl),
}

enum Merging {
    /// A plain item's mesh, still in the model RTC frame if it was rebased.
    Item(Mesh),
    /// A nested source's placed frame parts.
    Nested(Vec<Mesh>),
    /// A textured face set with its UVs (#961, #1781).
    Textured(u32, Mesh, Vec<f32>),
    /// A styled plain item's mesh, kept under its own id.
    Styled(u32, Mesh),
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
    /// Resolve a merged mapped item's source, transform and cache entry.
    Enter(Reached<'a>),
    /// Resolve a styled mapped item's source, transform and eligibility.
    EnterStyled(Reached<'a>),
    /// Resolve the type map's representation and items.
    EnterTypeMap,
    /// Resolve a shared registry source's items.
    SharedItems(Reached<'a>, u32, Option<Placeholder>),
    /// Resolve a claimed styled source's items.
    StyledItems(Pending),
    /// Build a textured face set with its UVs.
    Texture(Reached<'a>),
    /// One plain source item through the common item or cache controller.
    Child(Reached<'a>, ChildControl),
    /// Merge into the innermost source's accumulator, in item order.
    Merge(Merging),
    /// Close the innermost source's accumulator, or bake a styled source.
    Finish,
    /// Resolve the type map's MappingOrigin, after its last item.
    Origin,
    /// Bake the MappingOrigin into the type map's parts.
    TypeFinish(Option<Matrix4<f64>>),
    /// Place an occurrence's source-coords parts by its mapping.
    Place(Place),
    /// Push a don't-bake occurrence's placeholder.
    Placeholder(Placeholder),
    Complete(Result<MappingOutput>),
    /// Moved out by an executing or accepting step.
    Taken,
}

/// A completed walk's output.
pub(super) enum MappingOutput {
    Parts(Vec<Mesh>),
    Styled(SubMeshCollection),
    Type(TypeParts),
}

pub(super) enum Merged {
    Parts(SourceParts),
    Textured(Result<Vec<TexturedPart>>),
    Styled(SubMeshCollection),
}

pub(super) enum MappingReply {
    Entered { item_id: u32, value: Result<(u32, MappedOccurrence)> },
    SharedItems(Vec<DecodedEntity>),
    Child(ItemStep),
    Merged(Merged),
    Finished(Result<Vec<Mesh>>),
    Placed { item_id: u32, truncated: bool, value: Result<Vec<Mesh>> },
    CacheChild(CacheReply),
    StyledEntered { item_id: u32, value: Result<StyledSource> },
    StyledItems(Result<Vec<DecodedEntity>>),
    Textured(Option<(Mesh, Vec<f32>)>),
    TypeMapEntered(Result<(DecodedEntity, Vec<DecodedEntity>)>),
    Origin(Result<Option<Matrix4<f64>>>),
    TypeFinished(Result<TypeParts>),
    StyledFinished(SubMeshCollection),
    Placeholder(SubMeshCollection),
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
            Self::CacheChild(_) => 6,
            Self::StyledEntered { .. } => 7,
            Self::StyledItems(_) => 8,
            Self::Textured(_) => 9,
            Self::TypeMapEntered(_) => 10,
            Self::Origin(_) => 11,
            Self::TypeFinished(_) => 12,
            Self::StyledFinished(_) => 13,
            Self::Placeholder(_) => 14,
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
    walk: Walk,
    textures: Textures<'a>,
    /// The type map's `IfcRepresentationMap`.
    rep_map: Option<&'a DecodedEntity>,
    /// Styled only: whether the top-level occurrence may don't-bake.
    allow_instancing: bool,
    /// The styled walk's sub-meshes, and the type map's textured parts.
    meshes: SubMeshCollection,
    textured: Vec<TexturedPart>,
    levels: Vec<Level>,
    action: Action<'a>,
}

impl<'a> MappingControl<'a> {
    fn new(walk: Walk, action: Action<'a>) -> Self {
        Self {
            walk,
            textures: None,
            rep_map: None,
            allow_instancing: false,
            meshes: SubMeshCollection::new(),
            textured: Vec::new(),
            levels: Vec::new(),
            action,
        }
    }

    pub(super) fn occurrence(item: Reached<'a>) -> Self {
        Self::new(Walk::Occurrence, Action::Enter(item))
    }

    #[cfg(test)]
    pub(super) fn shared_source(representation: &'a DecodedEntity, source_id: u32) -> Self {
        Self::new(Walk::Shared, Action::SharedItems(Reached::Root(representation), source_id, None))
    }

    /// One styled representation item, appending to `meshes`. A plain item
    /// is meshed under its own id; a mapped item walks its source.
    pub(super) fn styled(root: Reached<'a>, meshes: SubMeshCollection, allow_instancing: bool,
        textures: Textures<'a>, offset: (f64, f64, f64)) -> Self {
        let item = root.item();
        let action = if item.ifc_type == ifc_lite_core::IfcType::IfcMappedItem {
            Action::EnterStyled(root)
        } else if textures.is_some_and(|index| index.contains_key(&item.id)) {
            Action::Texture(root)
        } else {
            Action::Child(root, ChildControl::Cache(CacheControl::new(offset)))
        };
        Self { textures, allow_instancing, meshes, ..Self::new(Walk::Styled, action) }
    }

    pub(super) fn type_map(rep_map: &'a DecodedEntity, textures: &'a FxHashMap<u32, ResolvedTextureMap>) -> Self {
        Self { textures: Some(textures), rep_map: Some(rep_map), ..Self::new(Walk::TypeMap, Action::EnterTypeMap) }
    }

    pub(super) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        Ok(match &self.action {
            Action::Enter(_) | Action::EnterStyled(_) | Action::EnterTypeMap | Action::SharedItems(..)
            | Action::StyledItems(_) | Action::Texture(_) | Action::Origin => Some(ProgramStage::Source),
            Action::Child(_, ChildControl::Item(control)) => return control.stage(),
            Action::Child(_, ChildControl::Cache(control)) => return control.stage(),
            Action::Merge(_) | Action::Finish | Action::TypeFinish(_) | Action::Place(_) | Action::Placeholder(_) => {
                Some(ProgramStage::Numerical)
            }
            Action::Complete(_) => None,
            Action::Taken => return Err(ProgramError::Outstanding),
        })
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<MappingReply, ProgramError> {
        // Steps that keep their action in place: the accept consumes it.
        match &mut self.action {
            Action::Child(item, ChildControl::Item(control)) => {
                return control.execute(item.item(), router, decoder).map(MappingReply::Child);
            }
            Action::Child(item, ChildControl::Cache(control)) => {
                return control.execute(item.item(), router, decoder).map(MappingReply::CacheChild);
            }
            Action::SharedItems(representation, ..) => {
                return Ok(MappingReply::SharedItems(GeometryRouter::shared_source_items(representation.item(), decoder)));
            }
            Action::StyledItems(pending) => {
                let items = GeometryRouter::styled_source_items(&pending.representation, decoder);
                return Ok(MappingReply::StyledItems(items));
            }
            Action::Texture(item) => {
                let item = item.item();
                let map = self.textures.and_then(|index| index.get(&item.id)).ok_or(ProgramError::StaleRequest)?;
                return Ok(MappingReply::Textured(router.textured_face_set(item, decoder, map, Some(router.rtc_offset()))));
            }
            _ => {}
        }
        Ok(match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Enter(entering) => {
                let item = entering.item();
                let value = router.admit_mapped_occurrence(item, decoder);
                MappingReply::Entered { item_id: item.id, value }
            }
            Action::EnterStyled(entering) => {
                let item = entering.item();
                // Only the top-level occurrence is independent: a nested map is
                // part of its parent's shared geometry, never don't-baked.
                let eligible = self.allow_instancing && self.levels.is_empty();
                let value = router.admit_styled_occurrence(item, eligible, self.textures, decoder);
                MappingReply::StyledEntered { item_id: item.id, value }
            }
            Action::EnterTypeMap => {
                let rep_map = self.rep_map.ok_or(ProgramError::StaleRequest)?;
                MappingReply::TypeMapEntered(router.admit_type_map(rep_map, decoder))
            }
            Action::Origin => {
                let rep_map = self.rep_map.ok_or(ProgramError::StaleRequest)?;
                MappingReply::Origin(router.type_map_origin(rep_map, decoder))
            }
            Action::TypeFinish(origin) => {
                let level = self.levels.last_mut().ok_or(ProgramError::StaleRequest)?;
                let parts = std::mem::take(&mut level.parts);
                let textured = std::mem::take(&mut self.textured);
                MappingReply::TypeFinished(router.finish_type_map(parts, textured, origin.as_ref()))
            }
            Action::Merge(merging) => self.merge(merging, router)?,
            Action::Finish => self.finish(router)?,
            Action::Place(place) => Self::place(place, router),
            Action::Placeholder(placeholder) => self.push_placeholder(placeholder),
            other => {
                self.action = other;
                return Err(ProgramError::StaleRequest);
            }
        })
    }

    pub(super) fn take_result(&mut self) -> Option<Result<MappingOutput>> {
        match std::mem::replace(&mut self.action, Action::Taken) {
            Action::Complete(result) => Some(result),
            other => {
                self.action = other;
                None
            }
        }
    }
}

#[path = "mapping_accept.rs"]
mod accept;
#[path = "mapping_reduce.rs"]
mod reduce;
