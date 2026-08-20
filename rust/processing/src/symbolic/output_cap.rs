// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The extraction-level output bound for `SymbolicData` (#2937, #2938).
//!
//! Split out of `primitives.rs` for the same reason `item_walk.rs` is split
//! out of `items.rs`: that file is the WIRE SHAPE of the symbolic stream, and
//! this is the policy deciding how much of it one extraction may produce. A
//! reader auditing the bound should not have to read five primitive structs
//! to find it, and a reader adding a primitive should not have to step around
//! the bound.

use super::primitives::{
    SymbolicCircle, SymbolicData, SymbolicFillArea, SymbolicGridAxis, SymbolicPolyline,
    SymbolicText,
};
use serde::{Deserialize, Serialize};

/// Upper bound on the total number of symbolic primitives one extraction may
/// emit, across every product in the file.
///
/// The per-item recursion bounds in `item_walk.rs` bound ONE top-level
/// representation item. `extract_symbolic_data` calls the walk once per item of
/// every Plan/Annotation/FootPrint/Axis representation of every product and
/// accumulates into one `SymbolicData`, so the file-level total was
/// `items x per-item bound` and nothing bounded the extraction (#2937).
/// Measured on a crafted acyclic DAG: 20,002,500 polylines and **2.74 GB RSS from a 1.13 MB upload**, linear in file size, on a path the HTTP server calls
/// with raw uploaded bytes (`apps/server/src/services/streaming.rs`).
///
/// Sized to sit well above real drawings rather than close to them. A flat
/// `IfcGeometricCurveSet` of 200,050 curves is legitimate (plan hatching, a
/// survey drawing, an imported DWG), and a nested block import reaching
/// 500,000 is too, so this leaves roughly 4x headroom over the largest known
/// legitimate case while still refusing the 20M one. Hitting it is reported,
/// never silent -- see [`SymbolicData::truncated`].
pub const MAX_SYMBOLIC_ELEMENTS: usize = 2_000_000;

/// Upper bound on the estimated heap footprint of one extraction's output.
///
/// [`MAX_SYMBOLIC_ELEMENTS`] alone is NOT a memory bound, because per-primitive
/// size is attacker-controlled: `SymbolicPolyline.points` and
/// `SymbolicText.content` have no length limit anywhere in the extractor, and
/// the fan-out attack re-emits ONE leaf up to the cap, cloning its point vector
/// every time. So the leaf is paid for once in the file and two million times
/// in RAM. Measured against a count-only cap, leaf point count the only knob:
///
///   leaf pts   fixture     emitted      peak RSS
///          2   0.15 MB   2,000,000        278 MB
///        512   1.07 MB   2,000,000       8.47 GB
///       1024   2.03 MB   2,000,000      16.70 GB
///
/// Linear, and six times worse than the 2.74 GB the count cap was written to
/// fix. A count cap tuned on a 2-point fixture measures the fixture, not the
/// bound.
///
/// Every append charges its own estimated footprint, so a file of few enormous
/// primitives and a file of many tiny ones are stopped at the same number of
/// BYTES -- but only for fields the charge actually includes, which is why
/// every variable-length field must be in the payload and not just the obvious
/// one.
///
/// Headroom, stated honestly rather than as "far above any real drawing": 256
/// MiB is ~33.5M charged payload units. The largest cited legitimate cases
/// (200,050 curves; ~500,000 simple polylines, roughly 40 MB) clear it by ~6x.
/// A DENSE vector import does not have that margin -- 100k contour polylines at
/// 2,000 points each is ~200M coordinates and WOULD be truncated. That is a
/// real drawing, and the honest position is that it degrades visibly (the
/// result says so) rather than silently, which is the difference this change is
/// about. Raise the constant if such a file turns up; do not assume it cannot.
pub const MAX_SYMBOLIC_BYTES: usize = 256 * 1024 * 1024;

/// Heap footprint charged for one emitted primitive.
///
/// Deliberately an ESTIMATE, and deliberately an over-estimate of the
/// per-primitive constant: `Vec`/`String` headers, capacity slack and allocator
/// rounding are real and a bound that ignores them is not a bound. Calibrated
/// against the measurements above, which work out at roughly 64 bytes of
/// fixed overhead plus 8 bytes per coordinate once allocator behaviour is
/// included.
const PRIMITIVE_OVERHEAD_BYTES: usize = 64;
/// Charged per `f32` coordinate or per byte of text.
const BYTES_PER_COORD: usize = 8;


/// Which bound stopped an extraction early.
///
/// `SymbolicData` had no diagnostics channel at all (#2938), so a drawing that
/// lost 60% of its curves was indistinguishable, in the response, from one that
/// legitimately had nothing more to emit.
///
/// The reason matters as much as the fact. #2938's own lead case is a
/// well-formed nested block import losing content to the PER-ITEM revisit
/// budget while the whole-file totals sit far below the extraction bounds --
/// so a diagnostic that only reported the extraction bounds would have reported
/// nothing on the exact scenario the issue is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SymbolicTruncationReason {
    /// [`MAX_SYMBOLIC_ELEMENTS`] reached.
    ElementCount,
    /// [`MAX_SYMBOLIC_BYTES`] reached.
    OutputBytes,
    /// One representation item nested deeper than the walk follows.
    ItemDepth,
    /// One representation item exhausted its revisit budget: the item was a
    /// large acyclic fan-out, or a legitimate deeply-nested block import.
    ItemRevisits,
}

/// What stopped an extraction early, when something did.
///
/// Present only on a truncated result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolicTruncation {
    /// The FIRST bound that fired. Later ones are the same event continuing.
    pub reason: SymbolicTruncationReason,
    /// Primitives emitted in total. NOT necessarily equal to any limit: a
    /// per-item bound stops one item's contribution while the file-level
    /// totals stay far below the extraction bounds.
    pub emitted: usize,
    /// The bound's value, when the reason has a single numeric one. `None` for
    /// per-item reasons, whose bound is per item and not comparable with
    /// `emitted`.
    pub limit: Option<usize>,
}



/// The extraction's accumulator: a `SymbolicData` under construction, plus the
/// bound it is being built under.
///
/// The bound lives HERE and not on `SymbolicData` because `SymbolicData` is the
/// wire type -- it is serialized into the response and into the on-disk parse
/// cache. A policy knob on it would have to be `#[serde(skip)]` with a
/// hand-written `Default` to stop `SymbolicData::default()` truncating on its
/// first append, and every struct literal in the repo would break on the
/// private field. None of that buys anything: the cap is a property of the
/// EXTRACTION, and this is where extraction state belongs.
///
/// It also makes the seam real rather than conventional. During extraction the
/// vectors are reachable only through `push_*`, because the emitters hold an
/// accumulator and not a `SymbolicData`; the `pub` fields on the wire type are
/// then harmless, since nothing is emitting through them.
pub(super) struct SymbolicAccumulator {
    data: SymbolicData,
    /// Cap for this extraction. Injectable so a test can use 500 rather than
    /// building a fixture that emits two million primitives.
    limit: usize,
    /// Refused appends, counted for tests. See [`Self::refusals`].
    #[cfg(test)]
    refusals: usize,
    /// Estimated heap footprint charged so far. See [`MAX_SYMBOLIC_BYTES`].
    bytes: usize,
    /// Byte bound for this extraction, injectable alongside `limit`.
    byte_limit: usize,
    /// The first bound that fired, if any. Later ones are the same event.
    reason: Option<SymbolicTruncationReason>,
    /// Set only by the EXTRACTION bounds, never by a per-item one.
    ///
    /// These are two different questions and conflating them is a bug: "was
    /// content dropped anywhere" is what the caller must be told, while "must
    /// I stop walking the rest of the file" is true only when the accumulator
    /// itself is full. A deep or fan-heavy single item drops its own content
    /// and must NOT abandon every remaining product.
    exhausted: bool,
}

impl SymbolicAccumulator {
    /// Accumulator under the shipped cap.
    pub(super) fn new() -> Self {
        Self {
            data: SymbolicData::default(),
            limit: MAX_SYMBOLIC_ELEMENTS,
            bytes: 0,
            byte_limit: MAX_SYMBOLIC_BYTES,
            reason: None,
            exhausted: false,
            #[cfg(test)]
            refusals: 0,
        }
    }

    /// Accumulator under caller-chosen bounds. Both are injectable so a test
    /// can exercise either bound without building a fixture that reaches the
    /// shipped ones.
    #[cfg(test)]
    pub(super) fn with_limits(limit: usize, byte_limit: usize) -> Self {
        Self { limit, byte_limit, ..Self::new() }
    }

    /// Accumulator under a caller-chosen count cap and the shipped byte cap.
    #[cfg(test)]
    pub(super) fn with_limit(limit: usize) -> Self {
        Self { limit, ..Self::new() }
    }

    /// Is the accumulator itself full? The walk and the product scan read THIS
    /// to stop early. A per-item bound marks the result truncated WITHOUT setting
    /// this, so one deep item does not abandon every later product.
    pub(super) fn is_exhausted(&self) -> bool {
        self.exhausted
    }

    /// Record that a per-item bound dropped content. Called by the walk, which
    /// is the only place that knows a bound fired -- refusing to append is not
    /// the same event and would report the wrong reason.
    pub(super) fn note_item_bound(&mut self, reason: SymbolicTruncationReason) {
        self.record(reason);
    }

    /// Keep the MOST SEVERE reason, not the first.
    ///
    /// First-wins is right within a bound class -- the second refusal at the
    /// same cap is the same event continuing -- and wrong ACROSS classes. A
    /// per-item bound firing on the first product is ordinary; the whole-output
    /// cap firing later is the DoS-scale event, and scan order is
    /// attacker-controlled. First-wins therefore let a file that blew the
    /// 2,000,000-element ceiling report the mild `item-revisits` instead, with
    /// its numeric limit dropped, purely because an unrelated item truncated
    /// earlier in the file.
    fn record(&mut self, reason: SymbolicTruncationReason) {
        let severity = |r: SymbolicTruncationReason| match r {
            SymbolicTruncationReason::ElementCount | SymbolicTruncationReason::OutputBytes => 1,
            SymbolicTruncationReason::ItemDepth | SymbolicTruncationReason::ItemRevisits => 0,
        };
        match self.reason {
            Some(existing) if severity(existing) >= severity(reason) => {}
            _ => self.reason = Some(reason),
        }
    }

    /// Refused appends since the last reset, for tests only.
    ///
    /// Exists so the early exits can be pinned deterministically. They bound
    /// WORK, and work is invisible in the output -- a refused append leaves the
    /// result byte-identical -- but it is visible HERE, and the accumulator is
    /// already test-injectable. Claiming this was unpinnable was wrong.
    #[cfg(test)]
    pub(super) fn refusals(&self) -> usize {
        self.refusals
    }

    /// Total primitives emitted so far, across every collection.
    fn len(&self) -> usize {
        self.data.len()
    }

    /// Would appending a primitive of `payload` units exceed either bound?
    ///
    /// Two bounds, and the honest reason is NOT symmetry. Bytes alone would do
    /// as a memory bound: every append charges at least
    /// `PRIMITIVE_OVERHEAD_BYTES`, so 256 MiB caps a tiny-primitive flood at
    /// ~4.2M anyway. The count bound earns its place differently -- its
    /// constant is sized on drawing semantics (4x the largest legitimate case)
    /// and it bounds the per-primitive costs downstream of this crate that a
    /// byte estimate does not govern: JSON serialization, cache writes, and
    /// client-side render setup are per-ELEMENT, not per-byte.
    fn exceeded_by(&self, payload: usize) -> Option<SymbolicTruncationReason> {
        if self.len() >= self.limit {
            return Some(SymbolicTruncationReason::ElementCount);
        }
        if self.bytes + PRIMITIVE_OVERHEAD_BYTES + payload * BYTES_PER_COORD > self.byte_limit {
            return Some(SymbolicTruncationReason::OutputBytes);
        }
        None
    }

    /// Charge an accepted append against the byte budget.
    fn charge(&mut self, payload: usize) {
        self.bytes += PRIMITIVE_OVERHEAD_BYTES + payload * BYTES_PER_COORD;
    }

    /// Append a grid axis unless the extraction has hit its cap.
    pub(super) fn push_grid_axis(&mut self, axis: SymbolicGridAxis) {
        // `tag` comes from the file. Grid extraction is top-level and
        // file-bounded so it has no fan-out amplifier, but an uncharged
        // heap field is the same class of hole as `alignment` was.
        let payload = axis.tag.len();
        if let Some(reason) = self.exceeded_by(payload) {
            self.record(reason);
            self.exhausted = true;
            #[cfg(test)]
            {
                self.refusals += 1;
            }
        } else {
            self.charge(payload);
            self.data.grid_axes.push(axis);
        }
    }

    /// Append a polyline unless the extraction has hit its cap.
    pub(super) fn push_polyline(&mut self, polyline: SymbolicPolyline) {
        let payload = polyline.points.len();
        if let Some(reason) = self.exceeded_by(payload) {
            self.record(reason);
            self.exhausted = true;
            #[cfg(test)]
            {
                self.refusals += 1;
            }
        } else {
            self.charge(payload);
            self.data.polylines.push(polyline);
        }
    }

    /// Append a circle unless the extraction has hit its cap.
    pub(super) fn push_circle(&mut self, circle: SymbolicCircle) {
        let payload = 8;
        if let Some(reason) = self.exceeded_by(payload) {
            self.record(reason);
            self.exhausted = true;
            #[cfg(test)]
            {
                self.refusals += 1;
            }
        } else {
            self.charge(payload);
            self.data.circles.push(circle);
        }
    }

    /// Append a text annotation unless the extraction has hit its cap.
    pub(super) fn push_text(&mut self, text: SymbolicText) {
        // alignment is read straight from IfcTextLiteralWithExtent's
        // BoxAlignment attribute with no length bound, and text literals are
        // dispatched INSIDE the fan-out walk, so it is cloned on every
        // emission. Omitting it made the byte bound a 13.5x under-count:
        // 800,100 texts charged 54.9 MB while the process held 3.45 GB and
        // `truncated` stayed None.
        let payload = text.content.len() + text.alignment.len();
        if let Some(reason) = self.exceeded_by(payload) {
            self.record(reason);
            self.exhausted = true;
            #[cfg(test)]
            {
                self.refusals += 1;
            }
        } else {
            self.charge(payload);
            self.data.texts.push(text);
        }
    }

    /// Append a filled region unless the extraction has hit its cap.
    pub(super) fn push_fill(&mut self, fill: SymbolicFillArea) {
        let payload = fill.points.len() + fill.holes_offsets.len();
        if let Some(reason) = self.exceeded_by(payload) {
            self.record(reason);
            self.exhausted = true;
            #[cfg(test)]
            {
                self.refusals += 1;
            }
        } else {
            self.charge(payload);
            self.data.fills.push(fill);
        }
    }

    /// Finish, stamping the diagnostics field iff an append was ever refused.
    pub(super) fn into_data(mut self) -> SymbolicData {
        if let Some(reason) = self.reason {
            let emitted = self.data.len();
            let limit = match reason {
                SymbolicTruncationReason::ElementCount => Some(self.limit),
                SymbolicTruncationReason::OutputBytes => Some(self.byte_limit),
                // Per-item bounds are per ITEM; reporting one next to a
                // file-level `emitted` would invite the reader to compare two
                // numbers that are not comparable.
                SymbolicTruncationReason::ItemDepth
                | SymbolicTruncationReason::ItemRevisits => None,
            };
            self.data.truncated = Some(SymbolicTruncation { reason, emitted, limit });
        }
        self.data
    }
}
