// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Group subtraction (disjoint-cutter batching) and its outcome type.
//!
//! [`GroupCut`] says whether the group was cut and, if not, why, so the router
//! matches on it instead of comparing the returned mesh against the host (the
//! triangle-count and 0.1 % volume decoder of #1788, `router/voids/sweep.rs`,
//! which still serves the single-cutter path).

use super::{record_csg_op, ClippingProcessor};
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::kernel::mesh_bridge::{subtract_many, BatchSubtract};
use crate::mesh::Mesh;

/// Outcome of [`ClippingProcessor::subtract_mesh_many`].
#[must_use]
#[derive(Debug, Clone)]
pub enum GroupCut {
    /// The whole group was cut in conforming arrangements and every
    /// intermediate passed validation and the accept gates. Empty when the
    /// cutters engulf the host.
    Cut(Mesh),
    /// The host is untouched; the caller cuts the members one by one.
    Rejected(GroupReject),
}

/// Why a group was not cut. Only `InvalidOutput` and `GateRejected` record a
/// [`crate::diagnostics::BoolFailure`]: the others are the expected, handled
/// outcome (see [`ClippingProcessor::subtract_mesh_many`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupReject {
    /// The host has no triangles.
    EmptyHost,
    /// No cutter is non-empty and AABB-overlapping the host.
    NoOverlap,
    /// The #1109 escalation budget tripped inside one chunk's arrangement.
    BudgetTripped,
    /// A chunk's arrangement left an unrecovered constraint and its lenient
    /// batch failed the kernel's volume oracle.
    Nonconforming,
    /// Every chunk's arrangement conformed, but no cutter reaches the host
    /// solid: the kernel kept every host face and no cutter face.
    Unchanged,
    /// A chunk's intermediate failed [`ClippingProcessor::validate_mesh`]
    /// (recorded as `KernelOutputInvalid`).
    InvalidOutput,
    /// A chunk's intermediate was refused by the accept gates (recorded).
    GateRejected,
}

/// Cap on the cutters packed into ONE conforming arrangement. Void cutters
/// are order-free (set difference: host − {all} ≡ host − {chunk₁} − {chunk₂}
/// − …), and the N-ary arrangement cost is SUPER-LINEAR in the cutters in a
/// single arrangement. A Revit IfcBuildingElementPart with ~90 openings cost
/// ~12 s in one arrangement vs ~0.4 s chunked at 16 (30×), and on wasm that
/// single element alone blew the geometry-stream watchdog: an 86 MB model that
/// loaded in ~15 s natively STALLED at 40 s in the browser. Chunking bounds
/// the per-arrangement cost so no single element can stall the stream. It is
/// solid-equivalent (the batch path's contract is volume parity +
/// watertightness, not byte-identical tessellation); for
/// `live.len() <= MAX_CUTTERS_PER_ARRANGEMENT` it IS the prior single
/// arrangement.
const MAX_CUTTERS_PER_ARRANGEMENT: usize = 16;

impl ClippingProcessor {
    /// Subtract a GROUP of pairwise-disjoint opening cutters from the host in
    /// ONE conforming arrangement per chunk (disjoint-cutter batching).
    ///
    /// On any chunk's rejection the WHOLE group is rejected and the host is
    /// left un-cut: the router's per-opening sequential loop (own budget,
    /// #635 fallback machinery, own diagnostics) then takes over for the
    /// members. Rejection is the expected, handled outcome, so only an invalid
    /// kernel output or an accept-gate refusal records a failure; anything
    /// more would be noise on elements whose voids end up perfectly cut (the
    /// issue-582/583 zero-CSG-failure bar).
    pub fn subtract_mesh_many(&self, host_mesh: &Mesh, cutters: &[&Mesh]) -> GroupCut {
        if host_mesh.is_empty() {
            return GroupCut::Rejected(GroupReject::EmptyHost);
        }
        let live: Vec<&Mesh> = cutters
            .iter()
            .copied()
            .filter(|c| !c.is_empty() && Self::bounds_overlap(host_mesh, c))
            .collect();
        if live.is_empty() {
            return GroupCut::Rejected(GroupReject::NoOverlap);
        }
        // `None` until a chunk cuts: the host is only copied by the kernel.
        let mut cut: Option<Mesh> = None;
        for chunk in live.chunks(MAX_CUTTERS_PER_ARRANGEMENT) {
            let current = cut.as_ref().unwrap_or(host_mesh);
            // Census: record THIS kernel invocation's real operand sizes (the
            // current host + this chunk's cutters). Chunking runs the kernel once
            // per chunk, so report K real ops, not one synthetic op carrying the
            // whole group's cutter total. For live.len() <= cap this is one record
            // identical to the prior single arrangement.
            let chunk_tris: usize = chunk.iter().map(|c| c.triangle_count()).sum();
            record_csg_op(0, current.triangle_count(), chunk_tris);
            crate::kernel::budget::begin();
            let raw = subtract_many(current, chunk);
            if crate::kernel::budget::tripped() {
                // Escalation budget exceeded (#1109): the partial arrangement
                // is discarded whatever the kernel made of it (deterministic).
                return GroupCut::Rejected(GroupReject::BudgetTripped);
            }
            let raw = match raw {
                BatchSubtract::Cut(raw) => raw,
                BatchSubtract::Unchanged => continue,
                BatchSubtract::Nonconforming => {
                    return GroupCut::Rejected(GroupReject::Nonconforming);
                }
            };
            let next = Self::consolidate_coplanar(raw);
            // Validate each intermediate BEFORE it becomes the next chunk's host:
            // a non-watertight / invalid intermediate would silently corrupt every
            // subsequent subtraction. Same guard as `subtract_mesh`, per chunk.
            if !next.is_empty() && !self.validate_mesh(&next) {
                self.record_failure(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
                return GroupCut::Rejected(GroupReject::InvalidOutput);
            }
            if self.accept_gates_reject(BoolOp::Difference, &next) {
                return GroupCut::Rejected(GroupReject::GateRejected);
            }
            cut = Some(next);
        }
        match cut {
            Some(result) => {
                self.record_topology_tear(BoolOp::Difference, &result);
                GroupCut::Cut(result)
            }
            None => GroupCut::Rejected(GroupReject::Unchanged),
        }
    }
}
