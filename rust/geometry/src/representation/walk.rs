// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The visitor walk over a product's representation items and the
//! `IfcMappedItem`s among them: `Items → MappingSource → MappedRepresentation →
//! Items`, in DFS pre-order and list order.
//!
//! Decoder-only. The walk meshes nothing and owns no cache; what a visit does
//! (mesh, vote, count, slice) is the caller's [`WalkVisitor`]. Mapped nesting
//! is bounded by a depth cap AND a path-scoped visited set (AGENTS.md "Bounding
//! walks"): the set is entered on `enter_map` and left on `leave_map`, so a
//! source reached twice along different branches is a shared DAG node, not a
//! cycle. The nesting is at most [`MAX_MAPPED_ITEM_DEPTH`](ifc_lite_core::MAX_MAPPED_ITEM_DEPTH)
//! levels for geometry callers. An explicit task stack avoids native recursion;
//! a finite expansion budget also bounds branching acyclic DAGs.

use super::{product_shape, Select, ShapeError};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use ifc_lite_core::slot::IfcRepresentationMap;

mod engine;

/// What an `IfcMappedItem` among the items means to the walk.
#[derive(Clone, Copy)]
pub enum NestedMaps {
    /// Descend into every mapped item, in list order, to `max_depth` levels
    /// (the mesh walks). `max_levels` is the WORK budget (AGENTS.md "Bounding
    /// walks"): both the most mapped levels entered and the most Items
    /// members materialized across all occurrences in one walk. A DAG whose every
    /// branch succeeds never repeats a path id and never errors, yet expands to
    /// `2^levels` levels; neither the depth cap nor the path-scoped set sees
    /// it. Exhausting the budget is reported ([`WalkRefusal::Budget`]) and ends
    /// the walk.
    Expand { max_depth: u32, max_levels: u32 },
    /// A nested map ends the walk with [`WalkRefusal::TooDeep`] and nothing
    /// after it is visited: the source is not shareable (don't-bake instancing).
    Refuse,
    /// Hand the `IfcMappedItem` itself to `item` and do not descend (direct
    /// walks that delegate mapped items).
    Leaf,
    /// Descend into the FIRST mapped item of each level only, after the level's
    /// own non-mapped items; never branches (the RTC vote).
    FirstChain { max_depth: u32 },
}

/// A visitor's answer.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Flow {
    Continue,
    /// Do not descend into this mapped source (answer to `enter_map`); an
    /// ordinary item treats it as `Continue`.
    SkipChildren,
    /// End the whole walk.
    Stop,
}

/// Why the walk declined to enter, or to continue past, a mapped item. All
/// but the items of an entered level are refused before `enter_map`.
#[derive(Debug)]
pub enum WalkRefusal {
    /// The mapped item is already on the path.
    Cyclic,
    /// The depth cap, or a nested map under [`NestedMaps::Refuse`].
    TooDeep { max_depth: u32 },
    /// The `IfcMappedItem` has no `MappingSource` attribute.
    MissingSource,
    /// `MappingSource` does not resolve.
    UnresolvedSource,
    /// The map has no `MappedRepresentation` attribute.
    MissingMappedRepresentation,
    /// `MappedRepresentation` does not resolve.
    UnresolvedMappedRepresentation,
    /// The mapped representation has no `Items` attribute.
    MissingItems,
    /// The mapped-level or total Items-member allowance was exhausted.
    Budget { max_levels: u32 },
    /// The decoder failed on one of the references.
    Decode(ifc_lite_core::Error),
}

/// The fan-out budget every geometry caller walks with: far above any real
/// model's mapped levels and item references per element, finite for a hostile DAG.
pub const MAX_WALK_LEVELS: u32 = 1 << 16;

impl WalkRefusal {
    /// The error the strict callers have always reported for this refusal,
    /// with its exact message text; `item` is the refused `IfcMappedItem`'s id.
    pub fn into_error(self, item: u32) -> crate::Error {
        let msg = match self {
            WalkRefusal::Cyclic => format!("Detected cyclic IfcMappedItem reference at #{item}"),
            WalkRefusal::TooDeep { max_depth } => format!(
                "MappedItem nesting exceeded maximum depth of {max_depth} at #{item}"
            ),
            WalkRefusal::Budget { max_levels } => format!(
                "IfcMappedItem expansion exceeded the work budget of {max_levels} levels or item references at #{item}"
            ),
            WalkRefusal::MissingSource => "MappedItem missing MappingSource".to_string(),
            WalkRefusal::UnresolvedSource => "Failed to resolve MappingSource".to_string(),
            WalkRefusal::MissingMappedRepresentation => {
                "RepresentationMap missing MappedRepresentation".to_string()
            }
            WalkRefusal::UnresolvedMappedRepresentation => {
                "Failed to resolve MappedRepresentation".to_string()
            }
            WalkRefusal::MissingItems => "Representation missing Items".to_string(),
            WalkRefusal::Decode(error) => return crate::Error::CoreError(error),
        };
        crate::Error::geometry(msg)
    }
}

/// One `IfcMappedItem → IfcRepresentationMap → MappedRepresentation` level.
#[derive(Clone)]
pub struct MappedLevel {
    /// The `IfcMappedItem`.
    pub item: DecodedEntity,
    /// Its `IfcRepresentationMap`: the key of the shared source.
    pub map: DecodedEntity,
    /// The map's `MappedRepresentation`.
    pub mapped_rep: DecodedEntity,
}

impl MappedLevel {
    /// `MappingTarget · MappingOrigin` of this level, unscaled (file units);
    /// `None` when neither contributes. Callers scale: the router with its
    /// `scale_transform`, the symbolic walk with its unit scale.
    pub fn local_transform(
        &self,
        decoder: &mut EntityDecoder,
    ) -> crate::Result<Option<nalgebra::Matrix4<f64>>> {
        super::mapped_transform::mapped_item_local_transform(&self.item, &self.map, decoder)
    }
}

/// Where a visit happens.
pub struct WalkCtx<'a> {
    /// The product being walked; `None` when entered at a map or mapped item.
    pub element: Option<&'a DecodedEntity>,
    /// The representation holding the item; `None` when entered below the top.
    pub shape_rep: Option<&'a DecodedEntity>,
    /// The mapped levels entered so far, outermost first; empty for a direct item.
    pub path: &'a [MappedLevel],
}

pub trait WalkVisitor {
    /// A representation of the product, before its items.
    fn shape_rep(&mut self, _rep: &DecodedEntity) -> Flow {
        Flow::Continue
    }
    /// A representation item. Under every policy but [`NestedMaps::Leaf`] it is
    /// never an `IfcMappedItem`.
    fn item(&mut self, item: &DecodedEntity, at: &WalkCtx<'_>, decoder: &mut EntityDecoder) -> Flow;
    /// A mapped level was entered; its items follow unless `SkipChildren`.
    fn enter_map(
        &mut self,
        _level: &MappedLevel,
        _at: &WalkCtx<'_>,
        _decoder: &mut EntityDecoder,
    ) -> Flow {
        Flow::Continue
    }
    /// Pairs every `enter_map`, whatever it answered and however the level's
    /// items ended.
    fn leave_map(&mut self, _level: &MappedLevel) {}
    /// `item`, an `IfcMappedItem` at `ctx` (whose path excludes it), was refused.
    /// A root-list budget refusal instead identifies its holding representation.
    /// Unless the refusal is of its `Items` (`MissingItems`, `Decode` or `Budget`, after
    /// `enter_map`), it has no `enter_map`/`leave_map` pair.
    fn refused(&mut self, _item: &DecodedEntity, _why: WalkRefusal, _ctx: &WalkCtx<'_>) {}
}

/// The walk: which representations ([`Select`]) and how mapped items nest.
pub struct RepresentationWalk {
    pub select: Select,
    pub nested: NestedMaps,
}

struct Run<'a, V> {
    visitor: &'a mut V,
    element: Option<&'a DecodedEntity>,
    /// The levels entered, outermost first: also the path-scoped visited set
    /// (at most `max_depth` entries, so a scan is the cheapest set).
    path: Vec<MappedLevel>,
    /// Mapped levels entered so far (the work budget's meter).
    levels: u32,
    /// Items members admitted before allocating/decoding a list, per occurrence.
    items: u32,
}

impl RepresentationWalk {
    /// Walk the selected representations of `element`.
    pub fn product<V: WalkVisitor>(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        visitor: &mut V,
    ) -> Result<(), ShapeError> {
        let Some(shape) = product_shape(element, decoder)? else {
            return Ok(());
        };
        let mut run = Run { visitor, element: Some(element), path: Vec::new(), levels: 0, items: 0 };
        for rep in shape.select(element, self.select) {
            if run.visitor.shape_rep(rep) == Flow::Stop {
                break;
            }
            let Some(items) = self.root_items(&mut run, rep, decoder)? else { break; };
            if self.items(&mut run, Some(rep), &items, decoder) == Flow::Stop {
                break;
            }
        }
        Ok(())
    }

    /// Walk the items of an `IfcRepresentationMap`'s mapped representation (a
    /// shared source, a type's map).
    pub fn map<V: WalkVisitor>(
        &self,
        map: &DecodedEntity,
        decoder: &mut EntityDecoder,
        visitor: &mut V,
    ) -> Result<(), ShapeError> {
        let Some(rep) = map.attr(IfcRepresentationMap::MAPPED_REPRESENTATION).map(|a| decoder.resolve_ref(a)).transpose()?.flatten() else {
            return Err(ShapeError::MissingItems);
        };
        let mut run = Run { visitor, element: None, path: Vec::new(), levels: 0, items: 0 };
        let Some(items) = self.root_items(&mut run, &rep, decoder)? else { return Ok(()); };
        self.items(&mut run, Some(&rep), &items, decoder);
        Ok(())
    }

    /// Walk from one `IfcMappedItem` (the item's own level is the first entered).
    pub fn mapped_item<V: WalkVisitor>(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        visitor: &mut V,
    ) {
        let mut run = Run { visitor, element: None, path: Vec::new(), levels: 0, items: 0 };
        self.execute(&mut run, engine::Task::Enter(item.clone()), decoder);
    }

}
