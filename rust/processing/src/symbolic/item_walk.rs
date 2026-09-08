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
use super::output_cap::{SymbolicAccumulator, SymbolicTruncationReason};
use super::rebase::RenderFrameRebase;
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
/// Kept in step with `MAX_MAPPED_ITEM_DEPTH` in `element/element_color.rs` and in
/// `geometry/src/router/processing.rs`, which walk the same mapped-item chain.
pub(super) const MAX_ITEM_DEPTH: u32 = 32;

/// Number of times the WHOLE EXTRACTION may re-enter an id it has already
/// visited, shared across every top-level item.
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
///
/// The BUDGET this bounds lives on `SymbolicAccumulator`
/// (`output_cap::SymbolicAccumulator::charge_revisit`), not on [`ItemWalk`],
/// and that placement is the fix for #2937: `extract_symbolic_item` builds a
/// fresh `ItemWalk` for every top-level item, so a budget stored there reset
/// on every item and a file of N items got `N x MAX_ITEM_REVISITS` instead of
/// one bound governing the file. The accumulator is threaded through the
/// whole extraction, so charging it once per revisit -- wherever in the file
/// that revisit happens -- is what makes this a FILE bound rather than an
/// ITEM bound.
///
/// THE VALUE HAS NOT BEEN RE-SIZED FOR ITS NEW SCOPE, and that is a deliberate
/// choice rather than an oversight. 200,000 was picked as a per-item number
/// and is now spent across the whole file, so a file whose revisits are spread
/// over many top-level items can truncate where `main` did not: a 12-product
/// nested block import (306 KB) emits 202,400 of its 240,000 curves here and
/// all 240,000 on `main`.
///
/// It is kept because the alternative is worse and the loss is REPORTED. The
/// same 240,000 curves already truncate on `main` at 200,200 when they sit
/// under ONE top-level item -- so the mis-sizing predates this change; what
/// this widens is which arrangements of the same file hit it. Raising the
/// constant trades directly against the hole this bound exists to close (a
/// fan-out spread thinly across items, which nothing bounded before), and that
/// trade wants a corpus measurement rather than a guess. Until then, a file
/// that loses content says so via `truncated`, which is the property that
/// makes the current value tolerable.
pub(super) const MAX_ITEM_REVISITS: u32 = 200_000;

/// State threaded through the walk: the ancestors on the current path, and the
/// remaining emit budget.
pub(super) struct ItemWalk {
    /// Every node on the CURRENT path -- inserted on entry, removed on exit.
    ///
    /// Holds items AND the non-item nodes the walk re-enters through. Express
    /// ids are unique per file, so one set needs no separation between them,
    /// and that matters: the `IfcMappedItem -> IfcRepresentationMap ->
    /// IfcShapeRepresentation.Items` chain re-enters through the
    /// REPRESENTATION, which is not an item. A representation whose own items
    /// map back to it is therefore a cycle an item-only path cannot see -- it
    /// presents as an innocent k-way fan-out that only the revisit budget
    /// stops, at `O(k^depth)` charges taken from a budget the rest of the file
    /// still needs. `a_cycle_must_not_starve_the_geometry_that_follows_it`
    /// pins that route; `a_set_cycle_must_not_starve_the_geometry_that_follows_it`
    /// pins the item-only route (`IfcGeometricCurveSet.Elements` back to
    /// itself), which no other bound covers.
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
    /// Only used to tell a FIRST visit from a REVISIT. See
    /// [`MAX_ITEM_REVISITS`] for why that distinction is what makes the budget
    /// safe to have at all.
    ///
    /// Deliberately still scoped to ONE top-level item, unlike the budget
    /// itself (#2937): a node reached for the first time under THIS item's
    /// own walk is a first visit regardless of whether some earlier,
    /// unrelated top-level item also reached it, and charging that would
    /// punish ordinary multi-product files (many placements of the same
    /// library block) for the crime of existing. Only a REVISIT within one
    /// item's own walk can be part of the exponential fan-out this budget
    /// guards against; see [`MAX_ITEM_REVISITS`].
    seen: FxHashSet<u32>,
}

impl ItemWalk {
    /// Put a node on the current path. `false` means it is already being
    /// expanded higher up this path -- a cycle -- and must not be re-entered.
    ///
    /// Node-general on purpose: the walk re-enters through nodes that are not
    /// representation items, and a seam named for one IFC type would leave the
    /// next such edge to hand-roll its own guard. Nothing here knows an IFC
    /// type; `items.rs` decides which ids are nodes.
    ///
    /// Every caller must pair a `true` with [`ItemWalk::exit_node`] and must
    /// not return in between. A leaked id stays on the path for the rest of
    /// this top-level item's walk, silently skipping every later occurrence of
    /// that node -- missing geometry with no error, which is the failure this
    /// module argues is worse than the cycle it guards against.
    pub(super) fn enter_node(&mut self, id: u32) -> bool {
        self.path.insert(id)
    }

    pub(super) fn exit_node(&mut self, id: u32) {
        self.path.remove(&id);
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
    rebase: RenderFrameRebase,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicAccumulator,
) {
    let mut walk = ItemWalk {
        path: FxHashSet::default(),
        seen: FxHashSet::default(),
    };
    extract_symbolic_item_at(
        item, decoder, express_id, ifc_type, rep_identifier, unit_scale, transform, rebase,
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
    rebase: RenderFrameRebase,
    styled_items: &HashMap<u32, Vec<u32>>,
    out: &mut SymbolicAccumulator,
    depth: u32,
    walk: &mut ItemWalk,
) {
    if depth >= MAX_ITEM_DEPTH {
        // Report it. This return DROPS CONTENT, and #2938 is precisely that it
        // did so in silence: the file-level totals stay far below the
        // extraction bounds, so nothing else in the pipeline notices.
        out.note_item_bound(SymbolicTruncationReason::ItemDepth);
        return;
    }
    // Stop WALKING once the accumulator is FULL -- not merely because some
    // earlier item reported dropping content, which must not abandon the rest
    // of the file.
    if out.is_exhausted() {
        return;
    }
    // A first visit is free: their number is bounded by the file. Only a
    // REVISIT can be part of an exponential fan-out, so only a revisit is
    // charged.
    if !walk.seen.insert(item.id) && !out.charge_revisit() {
        // #2938's LEAD case: a well-formed nested block import (2,000
        // inserts of a 250-curve symbol) loses 60% of its curves here while
        // emitting only 200,250 primitives -- far under both extraction
        // bounds. A diagnostic that reported only those bounds would say
        // nothing about the scenario the issue is actually about.
        //
        // The charge itself is against `out` (the accumulator), not a field
        // on `walk` -- see `MAX_ITEM_REVISITS` for why the budget must live
        // where it survives across top-level items rather than resetting
        // with each new `ItemWalk` (#2937).
        out.note_item_bound(SymbolicTruncationReason::ItemRevisits);
        return;
    }
    if !walk.enter_node(item.id) {
        out.note_item_bound(SymbolicTruncationReason::ItemCycle);
        return;
    }
    extract_symbolic_item_inner(
        item, decoder, express_id, ifc_type, rep_identifier, unit_scale, transform, rebase,
        styled_items, out, depth, walk,
    );
    walk.exit_node(item.id);
}

