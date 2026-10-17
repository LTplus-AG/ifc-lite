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
//! levels for every geometry caller, so the recursion below is bounded.

use super::{product_shape, rep_items, Select, ShapeError};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashSet;

/// What an `IfcMappedItem` among the items means to the walk.
#[derive(Clone, Copy)]
pub enum NestedMaps {
    /// Descend into every mapped item, in list order, to `max_depth` levels
    /// (the mesh walks).
    Expand { max_depth: u32 },
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

/// Why the walk declined to enter or continue past a mapped item.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WalkRefusal {
    /// A reference does not resolve (or the item has no `MappingSource`).
    Dangling,
    /// The mapped item is already on the path.
    Cyclic,
    /// The depth cap, or a nested map under [`NestedMaps::Refuse`].
    TooDeep,
    /// The map has no `MappedRepresentation`, or its `Items` cannot be read.
    Malformed,
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
    /// A mapped item at `at` (its id) was not entered.
    fn refused(&mut self, _at: u32, _why: WalkRefusal, _ctx: &WalkCtx<'_>) {}
}

/// The walk: which representations ([`Select`]) and how mapped items nest.
pub struct RepresentationWalk {
    pub select: Select,
    pub nested: NestedMaps,
}

struct Run<'a, V> {
    visitor: &'a mut V,
    element: Option<&'a DecodedEntity>,
    path: Vec<MappedLevel>,
    on_path: FxHashSet<u32>,
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
        let mut run = Run { visitor, element: Some(element), path: Vec::new(), on_path: FxHashSet::default() };
        for rep in shape.select(element, self.select) {
            if run.visitor.shape_rep(rep) == Flow::Stop {
                break;
            }
            let items = rep_items(rep, decoder)?;
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
        let Some(rep) = map.get(1).map(|a| decoder.resolve_ref(a)).transpose()?.flatten() else {
            return Err(ShapeError::MissingItems);
        };
        let items = rep_items(&rep, decoder)?;
        let mut run = Run { visitor, element: None, path: Vec::new(), on_path: FxHashSet::default() };
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
        let mut run = Run { visitor, element: None, path: Vec::new(), on_path: FxHashSet::default() };
        self.enter(&mut run, item, decoder);
    }

    /// Visit one list of items in order; the flow of the last visit.
    fn items<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        rep: Option<&DecodedEntity>,
        items: &[DecodedEntity],
        decoder: &mut EntityDecoder,
    ) -> Flow {
        let chain = matches!(self.nested, NestedMaps::FirstChain { .. });
        let mut first_mapped: Option<&DecodedEntity> = None;
        for item in items {
            if item.ifc_type == IfcType::IfcMappedItem && !matches!(self.nested, NestedMaps::Leaf) {
                if chain {
                    first_mapped = first_mapped.or(Some(item));
                } else if self.enter(run, item, decoder) == Flow::Stop {
                    return Flow::Stop;
                }
                continue;
            }
            let at = WalkCtx { element: run.element, shape_rep: rep, path: &run.path };
            if run.visitor.item(item, &at, decoder) == Flow::Stop {
                return Flow::Stop;
            }
        }
        match first_mapped {
            Some(item) => self.enter(run, item, decoder),
            None => Flow::Continue,
        }
    }

    /// Enter the level of one `IfcMappedItem`, visit its items, leave it.
    fn enter<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Flow {
        let max_depth = match self.nested {
            NestedMaps::Expand { max_depth } | NestedMaps::FirstChain { max_depth } => max_depth,
            NestedMaps::Refuse | NestedMaps::Leaf => 0,
        };
        let bail = matches!(self.nested, NestedMaps::Refuse);
        let refuse = |run: &mut Run<'_, V>, why| {
            let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
            run.visitor.refused(item.id, why, &at);
            if bail { Flow::Stop } else { Flow::Continue }
        };
        if run.path.len() >= max_depth as usize {
            return refuse(run, WalkRefusal::TooDeep);
        }
        if run.on_path.contains(&item.id) {
            return refuse(run, WalkRefusal::Cyclic);
        }
        let Some(source) = item.get(0).map(|a| decoder.resolve_ref(a)) else {
            return refuse(run, WalkRefusal::Dangling);
        };
        let Ok(Some(map)) = source else {
            return refuse(run, WalkRefusal::Dangling);
        };
        let mapped_rep = match map.get(1).map(|a| decoder.resolve_ref(a)) {
            Some(Ok(Some(rep))) => rep,
            _ => return refuse(run, WalkRefusal::Malformed),
        };
        let Ok(items) = rep_items(&mapped_rep, decoder) else {
            return refuse(run, WalkRefusal::Malformed);
        };
        let level = MappedLevel { item: item.clone(), map, mapped_rep };
        let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
        let mut flow = run.visitor.enter_map(&level, &at, decoder);
        run.path.push(level.clone());
        run.on_path.insert(item.id);
        if flow == Flow::Continue {
            flow = self.items(run, Some(&level.mapped_rep), &items, decoder);
        }
        run.on_path.remove(&item.id);
        run.path.pop();
        run.visitor.leave_map(&level);
        if flow == Flow::Stop { Flow::Stop } else { Flow::Continue }
    }
}
