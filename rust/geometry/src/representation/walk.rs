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
    /// The decoder failed on one of the references.
    Decode(ifc_lite_core::Error),
}

impl WalkRefusal {
    /// The error the strict callers have always reported for this refusal,
    /// with its exact message text; `item` is the refused `IfcMappedItem`'s id.
    pub fn into_error(self, item: u32) -> crate::Error {
        let msg = match self {
            WalkRefusal::Cyclic => format!("Detected cyclic IfcMappedItem reference at #{item}"),
            WalkRefusal::TooDeep { max_depth } => format!(
                "MappedItem nesting exceeded maximum depth of {max_depth} at #{item}"
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
    /// Unless the refusal is of its `Items` (`MissingItems` or `Decode`, after
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
        let mut run = Run { visitor, element: Some(element), path: Vec::new() };
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
        let mut run = Run { visitor, element: None, path: Vec::new() };
        self.items(&mut run, Some(&rep), &items, decoder);
        Ok(())
    }

    /// Walk `items` already resolved from `rep` (a caller that needed the
    /// representation itself first).
    pub fn items_of<V: WalkVisitor>(
        &self,
        rep: &DecodedEntity,
        items: &[DecodedEntity],
        decoder: &mut EntityDecoder,
        visitor: &mut V,
    ) {
        let mut run = Run { visitor, element: None, path: Vec::new() };
        self.items(&mut run, Some(rep), items, decoder);
    }

    /// Walk from one `IfcMappedItem` (the item's own level is the first entered).
    pub fn mapped_item<V: WalkVisitor>(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        visitor: &mut V,
    ) {
        let mut run = Run { visitor, element: None, path: Vec::new() };
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
            run.visitor.refused(item, why, &at);
            if bail { Flow::Stop } else { Flow::Continue }
        };
        if run.path.len() >= max_depth as usize {
            return refuse(run, WalkRefusal::TooDeep { max_depth });
        }
        if run.path.iter().any(|level| level.item.id == item.id) {
            return refuse(run, WalkRefusal::Cyclic);
        }
        let (map, mapped_rep) = match Self::resolve_level(item, decoder) {
            Ok(resolved) => resolved,
            Err(why) => return refuse(run, why),
        };
        let level = MappedLevel { item: item.clone(), map, mapped_rep };
        let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path };
        let mut flow = run.visitor.enter_map(&level, &at, decoder);
        run.path.push(level);
        if flow == Flow::Continue {
            // Resolved only for a level that runs: a source-cache hit never
            // decodes its items. A failure here is reported while the level is
            // still entered, with `ctx.path` excluding it, so a visitor can tell
            // it from a refusal that had no level.
            let rep = run.path[run.path.len() - 1].mapped_rep.clone();
            match Self::level_items(&rep, decoder) {
                Ok(items) => flow = self.items(run, Some(&rep), &items, decoder),
                Err(why) => {
                    let last = run.path.len() - 1;
                    let at = WalkCtx { element: run.element, shape_rep: None, path: &run.path[..last] };
                    run.visitor.refused(item, why, &at);
                    if bail { flow = Flow::Stop }
                }
            }
        }
        if let Some(level) = run.path.pop() {
            run.visitor.leave_map(&level);
        }
        if flow == Flow::Stop { Flow::Stop } else { Flow::Continue }
    }

    /// `MappingSource` and its `MappedRepresentation`, resolved in the order
    /// every walk reports its errors in.
    fn resolve_level(
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<(DecodedEntity, DecodedEntity), WalkRefusal> {
        let source = item.get(0).ok_or(WalkRefusal::MissingSource)?;
        let map = decoder
            .resolve_ref(source)
            .map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedSource)?;
        let rep = map.get(1).ok_or(WalkRefusal::MissingMappedRepresentation)?;
        let mapped_rep = decoder
            .resolve_ref(rep)
            .map_err(WalkRefusal::Decode)?
            .ok_or(WalkRefusal::UnresolvedMappedRepresentation)?;
        Ok((map, mapped_rep))
    }

    fn level_items(
        mapped_rep: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<DecodedEntity>, WalkRefusal> {
        let list = mapped_rep.get(3).ok_or(WalkRefusal::MissingItems)?;
        decoder.resolve_ref_list(list).map_err(WalkRefusal::Decode)
    }
}
