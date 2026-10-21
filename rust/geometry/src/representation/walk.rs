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

#[cfg(test)]
mod engine_tests;

/// What an `IfcMappedItem` among the items means to the walk.
#[derive(Clone, Copy)]
pub enum NestedMaps {
    /// Descend into every mapped item, in list order, to `max_depth` levels
    /// (the mesh walks). `max_levels` independently caps mapped-level attempts
    /// and materialized Items members across one walk. Every DAG occurrence
    /// pays again; exhaustion reports [`WalkRefusal::Budget`] and stops globally.
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

pub use super::refusal::WalkRefusal;

/// Recommended default for both independent Expand work meters.
pub const MAX_WALK_LEVELS: u32 = 1 << 16;

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
    /// The source and mapped representation resolved. Only `Continue` reads,
    /// charges and decodes its Items, after this callback; `SkipChildren` and
    /// `Stop` suppress those operations and their errors. The level entities
    /// are snapshots, but child references resolve through the decoder as
    /// mutated by this callback.
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
    /// A refused mapped item, or the holding representation for a root-list
    /// budget refusal. `ctx.path` excludes the refused level. Nested Items
    /// failures follow `enter_map` and are paired with `leave_map`; source,
    /// depth, cycle and level-budget failures occur before entry.
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
    /// Mapped-level attempts admitted after depth/cycle checks (Expand only).
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

    /// Walk already resolved items, retaining the holding representation.
    pub(crate) fn items_of<V: WalkVisitor>(
        &self, rep: &DecodedEntity, items: &[DecodedEntity],
        decoder: &mut EntityDecoder, visitor: &mut V,
    ) {
        let mut run = Run { visitor, element: None, path: Vec::new(), levels: 0, items: 0 };
        if let Err(why) = self.admit_items(&mut run.items, items.len()) {
            let at = WalkCtx { element: None, shape_rep: Some(rep), path: &run.path };
            run.visitor.refused(rep, why, &at);
            return;
        }
        self.items(&mut run, Some(rep), items, decoder);
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
