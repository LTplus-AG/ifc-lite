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
//! levels for every geometry caller, so the recursion below is bounded. Expand
//! also meters total mapped-level attempts and Items members across the walk.

use super::{product_shape, Select, ShapeError};
use ifc_lite_core::{slot::{IfcMappedItem, IfcRepresentation, IfcRepresentationMap}, DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashSet;

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
    path: Vec<MappedLevel>,
    on_path: FxHashSet<u32>,
    levels: u32,
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
        let mut run = Run { visitor, element: Some(element), path: Vec::new(), on_path: FxHashSet::default(), levels: 0, items: 0 };
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
        let mut run = Run { visitor, element: None, path: Vec::new(), on_path: FxHashSet::default(), levels: 0, items: 0 };
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
        let mut run = Run { visitor, element: None, path: Vec::new(), on_path: FxHashSet::default(), levels: 0, items: 0 };
        self.enter(&mut run, item, decoder);
    }

    /// Charge the full list before resolve_ref_list allocates or decodes any
    /// member, including ignored non-reference slots and repeated DAG uses.
    fn admit_items(&self, used: &mut u32, count: usize) -> Result<(), WalkRefusal> {
        if let NestedMaps::Expand { max_levels, .. } = self.nested {
            if count > (max_levels - *used) as usize {
                return Err(WalkRefusal::Budget { max_levels });
            }
            *used += count as u32;
        }
        Ok(())
    }

    /// Root errors retain ShapeError; budget exhaustion uses the visitor.
    fn root_items<V: WalkVisitor>(
        &self,
        run: &mut Run<'_, V>,
        rep: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<DecodedEntity>>, ShapeError> {
        let list = rep.attr(IfcRepresentation::ITEMS).ok_or(ShapeError::MissingItems)?;
        if let Err(why) = self.admit_items(&mut run.items, list.as_list().map_or(0, |l| l.len())) {
            let at = WalkCtx { element: run.element, shape_rep: Some(rep), path: &run.path };
            run.visitor.refused(rep, why, &at);
            return Ok(None);
        }
        Ok(Some(decoder.resolve_ref_list(list)?))
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
            NestedMaps::Expand { max_depth, .. } | NestedMaps::FirstChain { max_depth } => max_depth,
            NestedMaps::Refuse | NestedMaps::Leaf => 0,
        };
        let bail = matches!(self.nested, NestedMaps::Refuse);
        let refuse = |run: &mut Run<'_, V>, why| {
            let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
            run.visitor.refused(item, why, &at);
            if bail { Flow::Stop } else { Flow::Continue }
        };
        if run.path.len() >= max_depth as usize {
            return refuse(run, WalkRefusal::TooDeep { max_depth });
        }
        if run.on_path.contains(&item.id) {
            return refuse(run, WalkRefusal::Cyclic);
        }
        if let NestedMaps::Expand { max_levels, .. } = self.nested {
            if run.levels >= max_levels {
                refuse(run, WalkRefusal::Budget { max_levels });
                return Flow::Stop;
            }
            run.levels += 1;
        }
        let (map, mapped_rep) = match Self::resolve_level(item, decoder) {
            Ok(level) => level,
            Err(why) => return refuse(run, why),
        };
        let level = MappedLevel { item: item.clone(), map, mapped_rep };
        let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
        let mut flow = run.visitor.enter_map(&level, &at, decoder);
        run.path.push(level.clone());
        run.on_path.insert(item.id);
        if flow == Flow::Continue {
            match self.level_items(&mut run.items, &level.mapped_rep, decoder) {
                Ok(items) => flow = self.items(run, Some(&level.mapped_rep), &items, decoder),
                Err(why) => {
                    let terminal = matches!(why, WalkRefusal::Budget { .. });
                    // Items refusal describes this item at its parent context,
                    // while its entered scope is still active until leave_map.
                    let at = WalkCtx { element: run.element, shape_rep: None,
                        path: &run.path[..run.path.len() - 1] };
                    run.visitor.refused(item, why, &at);
                    if bail || terminal { flow = Flow::Stop; }
                }
            }
        }
        run.on_path.remove(&item.id);
        run.path.pop();
        run.visitor.leave_map(&level);
        if flow == Flow::Stop { Flow::Stop } else { Flow::Continue }
    }

    fn resolve_level(
        item: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, DecodedEntity), WalkRefusal> {
        let source = item.attr(IfcMappedItem::MAPPING_SOURCE).ok_or(WalkRefusal::MissingSource)?;
        let map = decoder.resolve_ref(source).map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedSource)?;
        let rep = map.attr(IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or(WalkRefusal::MissingMappedRepresentation)?;
        let mapped_rep = decoder.resolve_ref(rep).map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedMappedRepresentation)?;
        Ok((map, mapped_rep))
    }

    fn level_items(
        &self, used: &mut u32, rep: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<Vec<DecodedEntity>, WalkRefusal> {
        let list = rep.attr(IfcRepresentation::ITEMS).ok_or(WalkRefusal::MissingItems)?;
        self.admit_items(used, list.as_list().map_or(0, |items| items.len()))?;
        decoder.resolve_ref_list(list).map_err(WalkRefusal::Decode)
    }
}
