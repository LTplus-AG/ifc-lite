// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Group subtraction (disjoint-cutter batching) and the outcome type it shares
//! with the single-cutter `subtract_mesh`.
//!
//! [`GroupCut`] says whether the host was cut and, if not, why, so the router
//! matches on it instead of comparing the returned mesh against the host (the
//! triangle-count and 0.1 % volume decoder of #1788, deleted in #4692).

use super::{record_csg_op, ClippingProcessor};
use crate::diagnostics::{BoolFailureReason, BoolOp};
use crate::kernel::mesh_bridge::{subtract_many_with_conformity, BatchSubtract};
use crate::mesh::Mesh;

/// Outcome of [`ClippingProcessor::subtract_mesh_many`] and of
/// [`ClippingProcessor::subtract_mesh`], which is a group of one.
#[must_use]
#[derive(Debug, Clone)]
pub enum GroupCut {
    /// The kernel classified a cut, and every produced intermediate passed
    /// validation and the accept gates. Single-cutter arrangements are lenient;
    /// group cuts additionally require conformity or the kernel's volume oracle.
    /// Empty when the cutters engulf the host.
    Cut(Mesh),
    /// The kernel classified the cutter as not reaching the host solid,
    /// and this is the host re-tessellated along the
    /// arrangement, consolidated, validated and gated like a `Cut`. Same solid
    /// as the host, different triangles. Whether to keep it is the caller's
    /// choice; the void router has kept it when it changed the triangle count,
    /// and the watertightness census depends on that (#4692). A non-conforming
    /// same-count miss is `Rejected(Nonconforming)` instead (#5362).
    /// The public group API does not return this variant. The private void
    /// group opt-in can retain a conforming, count-changing miss (#6516).
    Retessellated(Mesh),
    /// The host is untouched; uncertain results need a per-member fallback.
    Rejected(GroupReject),
}

impl GroupCut {
    /// Whether the kernel established that no cutter reaches the host solid,
    /// as opposed to failing to cut one that does: there is nothing to
    /// approximate, so a fallback cut must not run (#5362).
    pub fn found_no_overlap(&self) -> bool {
        matches!(
            self,
            Self::Retessellated(_)
                | Self::Rejected(GroupReject::NoOverlap | GroupReject::EmptyHost | GroupReject::Unchanged)
        )
    }

    /// The mesh the subtract produced, a cut or a re-tessellated miss; `None`
    /// for a rejection.
    pub fn into_mesh(self) -> Option<Mesh> {
        match self {
            Self::Cut(m) | Self::Retessellated(m) => Some(m),
            Self::Rejected(_) => None,
        }
    }
}

/// Why a group was not cut. For a group, only `InvalidOutput` and
/// `GateRejected` record a [`crate::diagnostics::BoolFailure`]: the others are
/// the expected, handled outcome (see [`ClippingProcessor::subtract_mesh_many`]).
/// The single cutter records more; see [`ClippingProcessor::subtract_mesh`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupReject {
    /// The host has no triangles.
    EmptyHost,
    /// No cutter is non-empty and AABB-overlapping the host.
    NoOverlap,
    /// The #1109 escalation budget tripped inside one chunk's arrangement.
    BudgetTripped,
    /// A chunk's arrangement left an unrecovered constraint and its lenient
    /// batch failed the kernel's volume oracle or classified an uncertain miss.
    /// The single cutter returns it
    /// only for a non-conforming arrangement that changed nothing, which is
    /// not proof the cutter misses the host (#5362).
    Nonconforming,
    /// Every chunk's arrangement conformed, but no cutter reaches the host
    /// solid: the kernel kept every host face and no cutter face. Group only:
    /// the single cutter returns [`GroupCut::Retessellated`] instead.
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
        self.subtract_mesh_many_inner(host_mesh, cutters, false)
    }

    /// Reuse a validated, consolidated conforming miss only for a void group
    /// whose welded operands equal the sequential kernel operands (#6516).
    /// Other callers retain the public batch outcome contract.
    pub(crate) fn subtract_mesh_many_retaining_miss(&self, host_mesh: &Mesh, cutters: &[&Mesh]) -> GroupCut {
        self.subtract_mesh_many_inner(host_mesh, cutters, true)
    }

    fn subtract_mesh_many_inner(&self, host_mesh: &Mesh, cutters: &[&Mesh], retain_miss: bool) -> GroupCut {
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| c.group_subtract_calls = c.group_subtract_calls.saturating_add(1));
        if host_mesh.is_empty() {
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| c.group_rejections[0] = c.group_rejections[0].saturating_add(1));
            return GroupCut::Rejected(GroupReject::EmptyHost);
        }
        let live: Vec<&Mesh> = cutters
            .iter()
            .copied()
            .filter(|c| !c.is_empty() && Self::bounds_overlap(host_mesh, c))
            .collect();
        if live.is_empty() {
            #[cfg(feature = "opening-perf-trace")]
            crate::opening_perf_trace::record(|c| c.group_rejections[1] = c.group_rejections[1].saturating_add(1));
            return GroupCut::Rejected(GroupReject::NoOverlap);
        }
        // `None` until a chunk cuts: the host is only copied by the kernel.
        let mut cut: Option<Mesh> = None;
        let mut retessellated: Option<Mesh> = None;
        let mut misses_conform = true;
        // Do not change the host seen by a later chunk merely to preserve a
        // no-op. Multi-chunk groups keep their existing sequential fallback.
        let retain_miss = retain_miss && live.len() <= MAX_CUTTERS_PER_ARRANGEMENT;
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
            let (raw, conforming, miss) = subtract_many_with_conformity(current, chunk, true, retain_miss);
            if crate::kernel::budget::tripped() {
                // Escalation budget exceeded (#1109): the partial arrangement
                // is discarded whatever the kernel made of it (deterministic).
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.group_rejections[2] = c.group_rejections[2].saturating_add(1));
                return GroupCut::Rejected(GroupReject::BudgetTripped);
            }
            let (raw, changed) = match raw {
                BatchSubtract::Cut(raw) => (raw, true),
                BatchSubtract::Unchanged => {
                    misses_conform &= conforming;
                    let Some(miss) = miss else { continue; };
                    (miss, false)
                }
                BatchSubtract::Nonconforming => {
                    #[cfg(feature = "opening-perf-trace")]
                    crate::opening_perf_trace::record(|c| c.group_rejections[3] = c.group_rejections[3].saturating_add(1));
                    return GroupCut::Rejected(GroupReject::Nonconforming);
                }
            };
            let next = self.consolidate(raw);
            // Validate each intermediate BEFORE it becomes the next chunk's host:
            // a non-watertight / invalid intermediate would silently corrupt every
            // subsequent subtraction. Same guard as `subtract_mesh`, per chunk.
            if !next.is_empty() && !self.validate_mesh(&next) {
                self.record_failure(BoolOp::Difference, BoolFailureReason::KernelOutputInvalid);
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.group_rejections[5] = c.group_rejections[5].saturating_add(1));
                return GroupCut::Rejected(GroupReject::InvalidOutput);
            }
            if self.accept_gates_reject(BoolOp::Difference, &next) {
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| c.group_rejections[6] = c.group_rejections[6].saturating_add(1));
                return GroupCut::Rejected(GroupReject::GateRejected);
            }
            if changed { cut = Some(next); } else { retessellated = Some(next); }
        }
        match cut {
            Some(result) => {
                self.record_topology_tear(BoolOp::Difference, &result);
                GroupCut::Cut(result)
            }
            None => {
                if let Some(result) = retessellated {
                    // Same-count single misses are discarded by mesh_to_keep.
                    // Preserve that fallback/cleanup contract rather than
                    // newly mutating the host from a same-count group miss.
                    if result.triangle_count() != host_mesh.triangle_count() {
                        self.record_topology_tear(BoolOp::Difference, &result);
                        return GroupCut::Retessellated(result);
                    }
                }
                // Only a conforming classification proves the entire group
                // misses. Preserve the sequential fallback for uncertain misses,
                // including when the lenient volume check accepted them (#6516).
                let reason = if misses_conform || !retain_miss { GroupReject::Unchanged } else { GroupReject::Nonconforming };
                #[cfg(feature = "opening-perf-trace")]
                crate::opening_perf_trace::record(|c| {
                    let index = if matches!(reason, GroupReject::Unchanged) { 4 } else { 3 };
                    c.group_rejections[index] = c.group_rejections[index].saturating_add(1);
                });
                GroupCut::Rejected(reason)
            },
        }
    }
}
