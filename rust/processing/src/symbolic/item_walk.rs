// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounds for the symbolic representation-item walk (issue #2866).
//!
//! Split out of `items.rs` so the guards are readable on their own: `items.rs`
//! is the per-IFC-type dispatch, and this is the policy that keeps it from
//! walking a hostile file forever. Everything here is about WHAT the walk is
//! allowed to do; nothing here knows about any IFC type.

use super::items::extract_symbolic_item_inner;
use super::primitives::SymbolicData;
use super::transform::Transform2D;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashSet;
use std::collections::HashMap;

/// Maximum representation-item nesting this walk follows.
///
/// Every id below comes from the FILE, and a malformed or hostile IFC can
/// close a cycle three different ways here: `IfcGeometricSet.Elements` back to
/// itself, the `IfcMappedItem -> IfcRepresentationMap ->
/// IfcShapeRepresentation.Items` chain, and `IfcCompositeCurve.Segments ->
/// IfcCompositeCurveSegment.ParentCurve`. This walk is reachable from
/// `extract_symbolic_data` on raw uploaded bytes
/// (`apps/server/src/services/streaming.rs`), so unbounded each one aborts the
/// process with a stack overflow -- an abort, not a catchable panic (#2866).
///
/// Kept in step with `MAX_MAPPED_ITEM_DEPTH` in `element.rs` and in
/// `geometry/src/router/processing.rs`, which walk the same mapped-item chain.
const MAX_ITEM_DEPTH: u32 = 32;

/// Number of times this extraction may re-enter an id it has already visited.
///
/// A depth cap bounds a path's LENGTH and not its BREADTH: `k` items that each
/// lead back into a cycle cost `O(k^depth)`, so a cap alone converts an abort
/// into a hang -- measured at 7.21s for k=3 on the sibling resolver in #2864
/// before its guard landed. This is the breadth bound.
///
/// Charged on REVISITS ONLY, which is what makes it safe to have at all. An
/// earlier version charged every visit, and that silently truncated a
/// WELL-FORMED file: `IfcGeometricSet` recurses per element, so one flat set
/// of 200,050 curves emitted 199,999 and dropped 51 with no error -- plan
/// hatching, a survey drawing or imported DWG geometry reaches that size
/// legitimately. First visits are bounded by the file itself (an entity must
/// exist to be reached), so they cannot be the exponential; only revisits can,
/// and an acyclic DAG reaching one node down 2^levels paths is exactly that.
const MAX_ITEM_REVISITS: u32 = 200_000;

/// State threaded through the walk: the ancestors on the current path, and the
/// remaining emit budget.
pub(super) struct ItemWalk {
    /// Ancestors on the CURRENT path -- inserted on entry, removed on exit.
    ///
    /// Deliberately path-scoped rather than global, unlike `element.rs`'s
    /// colour resolver. A colour is a pure function of (item id, style map), so
    /// an id that resolved once cannot resolve differently elsewhere and a
    /// global set is safe there. This walk instead ACCUMULATES output and
    /// composes a `Transform2D` per path, so the same curve reached through two
    /// different mapped items is two real pieces of geometry at two different
    /// positions -- a global set would silently drop the second, which is
    /// missing geometry rather than a cycle guard. Same reasoning as
    /// `geometry/src/router/processing.rs`, which also accumulates per path.
    /// `the_same_polyline_under_two_mapped_items_is_emitted_twice` pins it.
    path: FxHashSet<u32>,
    /// Every id this extraction has entered, ever -- never removed.
    ///
    /// Only used to tell a FIRST visit from a REVISIT. A first visit is
    /// bounded by the file: an entity has to exist to be reached, so a flat
    /// `IfcGeometricCurveSet` with 200k children costs 200k first visits and
    /// nothing can make that exponential. Revisits are the whole danger --
    /// an acyclic DAG reaches the same node down 2^levels distinct paths.
    seen: FxHashSet<u32>,
    /// Charged on REVISITS only. See [`MAX_ITEM_REVISITS`].
    revisit_budget: u32,
    /// Representations being expanded on the CURRENT path -- the other way a
    /// mapped-item chain closes a cycle.
    ///
    /// `IfcMappedItem -> IfcRepresentationMap -> IfcShapeRepresentation.Items`
    /// re-enters the walk through the representation, which is NOT an item and
    /// so never appears in `path`. A representation whose own items map back to
    /// it is therefore a cycle the item path guard cannot see: it presents as a
    /// k-way fan-out that only the revisit budget stops, and stopping it there
    /// costs `O(k^depth)` charges taken from a budget the rest of the file
    /// still needs. `a_cycle_must_not_starve_the_geometry_that_follows_it` pins
    /// the consequence -- an 8-way self-referential map ahead of ordinary
    /// shared geometry drained the budget and dropped the geometry.
    ///
    /// Push/pop like `path`, not global, for the same reason: one
    /// representation reached through two different mapped items is two real
    /// pieces of geometry at two different positions.
    rep_path: FxHashSet<u32>,
}

impl ItemWalk {
    /// Begin expanding a mapped representation. `false` means it is already
    /// being expanded higher up this path -- a cycle -- and must be skipped.
    ///
    /// Every caller must pair a `true` with [`ItemWalk::exit_representation`].
    pub(super) fn enter_representation(&mut self, rep_id: u32) -> bool {
        self.rep_path.insert(rep_id)
    }

    pub(super) fn exit_representation(&mut self, rep_id: u32) {
        self.rep_path.remove(&rep_id);
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_symbolic_item(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicData,
) {
    let mut walk = ItemWalk {
        path: FxHashSet::default(),
        seen: FxHashSet::default(),
        revisit_budget: MAX_ITEM_REVISITS,
        rep_path: FxHashSet::default(),
    };
    extract_symbolic_item_at(
        item, decoder, express_id, ifc_type, rep_identifier, unit_scale, transform, rtc_x, rtc_z,
        styled_items, out, 0, &mut walk,
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) fn extract_symbolic_item_at(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    express_id: u32,
    ifc_type: &str,
    rep_identifier: &str,
    unit_scale: f32,
    transform: &Transform2D,
    rtc_x: f32,
    rtc_z: f32,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicData,
    depth: u32,
    walk: &mut ItemWalk,
) {
    if depth >= MAX_ITEM_DEPTH {
        return;
    }
    // A first visit is free: their number is bounded by the file. Only a
    // REVISIT can be part of an exponential fan-out, so only a revisit is
    // charged.
    if !walk.seen.insert(item.id) {
        match walk.revisit_budget.checked_sub(1) {
            Some(left) => walk.revisit_budget = left,
            None => return,
        }
    }
    if !walk.path.insert(item.id) {
        return;
    }
    extract_symbolic_item_inner(
        item, decoder, express_id, ifc_type, rep_identifier, unit_scale, transform, rtc_x, rtc_z,
        styled_items, out, depth, walk,
    );
    walk.path.remove(&item.id);
}

