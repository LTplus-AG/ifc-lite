// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Boolean / CSG failure diagnostics.
//!
//! Pre-T1.3, the CSG processor silently fell back to returning the un-cut host
//! mesh whenever it couldn't run an operation (cap exceeded, kernel error,
//! degenerate input, etc.). This left viewers rendering wrong geometry with no
//! signal to the user.
//!
//! This module gives every fallback a structured failure record. Callers can
//! drain failures off the `ClippingProcessor` after a sequence of operations
//! and surface them — e.g. a debug overlay that highlights products with
//! failed clips, or a CI assertion that no failures occurred on a known-good
//! fixture.
//!
//! The runtime behaviour is unchanged: failures are recorded *in addition*
//! to (not instead of) the existing fallback. The kernel regression tests
//! rely on these records.

use std::cell::RefCell;
use std::fmt;

thread_local! {
    /// Pending boolean failures from contexts that have no direct router
    /// handle. Historically fed by `MappedItemProcessor`'s transient
    /// `BooleanClippingProcessor` (deleted as dead code — every dispatch site
    /// special-cased `IfcMappedItem` before it could ever be reached; see the
    /// D5 dead-code sweep), so nothing pushes into this today. Kept + still
    /// drained by `take_csg_failures` in case a future non-router boolean
    /// context needs the same escape hatch.
    static PENDING_MAPPED_BOOL_FAILURES: RefCell<Vec<BoolFailure>> =
        const { RefCell::new(Vec::new()) };
}

/// Drain failures pushed from a context with no direct router handle (see
/// `PENDING_MAPPED_BOOL_FAILURES`).
pub fn take_pending_mapped_bool_failures() -> Vec<BoolFailure> {
    PENDING_MAPPED_BOOL_FAILURES.with(|cell| std::mem::take(&mut *cell.borrow_mut()))
}

/// Which boolean operation produced the failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoolOp {
    Difference,
    Union,
    Intersection,
    /// `IfcBooleanResult.Operator` was an unrecognised value — used by the
    /// boolean processor when classifying a failure for an unknown operator
    /// so the diagnostic doesn't mis-label the op as `Difference`.
    Unknown,
}

impl fmt::Display for BoolOp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BoolOp::Difference => f.write_str("DIFFERENCE"),
            BoolOp::Union => f.write_str("UNION"),
            BoolOp::Intersection => f.write_str("INTERSECTION"),
            BoolOp::Unknown => f.write_str("UNKNOWN"),
        }
    }
}

/// Why a boolean operation failed or was skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoolFailureReason {
    /// HISTORICAL: at least one operand exceeded the deleted legacy BSP CSG
    /// polygon cap. The pure-Rust exact kernel has no operand cap, so this is
    /// no longer emitted by the boolean ops; the variant (and its JSON label)
    /// is kept for the frozen diagnostics surface and void-router plumbing.
    OperandTooLarge {
        polys_a: usize,
        polys_b: usize,
    },
    /// One or both operand meshes were empty before polygon extraction.
    EmptyOperand,
    /// Polygon extraction yielded an empty list (degenerate / non-finite vertices).
    DegenerateOperand,
    /// Operand bounding boxes don't overlap. Informational — host returned unchanged.
    NoBoundsOverlap,
    /// The CSG kernel returned malformed polygons (NaN / non-finite).
    KernelOutputInvalid,
    /// HISTORICAL: solid-vs-solid `IfcBooleanResult.DIFFERENCE` was not
    /// attempted because the deleted legacy BSP could stack-overflow on
    /// arbitrary solid combinations. No longer emitted — the exact kernel
    /// always attempts the cut. Variant kept for the frozen label surface.
    SolidSolidDifferenceSkipped,
    /// `IfcPolygonalBoundedHalfSpace` prism-subtraction failed; the kernel
    /// fell back to an unbounded plane clip, silently dropping the polygonal
    /// boundary. The clip *is* applied but is a strict superset of the
    /// requested cut.
    PolygonalBoundedHalfSpaceFallback,
    /// The chained-clip cutter prisms couldn't be unioned into one watertight
    /// solid, so the single batched subtract (issue #960) was skipped and the
    /// chain fell back to sequential per-cutter subtraction. The cuts *are*
    /// applied, but abutting cutters may leave zero-thickness seam fins that
    /// the batched path would have eliminated.
    CutterUnionUnavailable,
    /// `IfcBooleanResult` operator string didn't match any known op.
    UnknownBooleanOperator(String),
    /// HISTORICAL: the deleted Manifold C++ kernel's `difference` returned
    /// output implausibly small relative to the host (a Linux-x86_64-only
    /// pathology). No longer emitted — the deterministic exact kernel
    /// replaced Manifold. Variant kept for the frozen label surface.
    ManifoldOutputDegenerate {
        host_tris: usize,
        result_tris: usize,
    },
    /// Catch-all for kernel-specific errors (free-form string).
    KernelError(String),
    /// `IfcBooleanResult.DIFFERENCE` produced an empty mesh from a non-empty
    /// host. Almost always a buggy export — a clip plane authored AT the
    /// wall's top with `AgreementFlag = .T.` (issue #821, Revit IFC2x3
    /// TallBuilding.ifc) makes the half-space material region exactly cover
    /// the wall body, so the strict-spec subtract yields nothing. The caller
    /// falls back to the un-cut host (matching what BIMVision and similar
    /// viewers do in practice) and records this so the loss surfaces in
    /// diagnostics rather than as a silently missing element.
    DifferenceEmptiedHost,
}

impl BoolFailureReason {
    /// Stable short label for per-reason aggregation. Single home shared by
    /// the wasm console diagnostics and the server tracing summary so the
    /// two surfaces cannot drift (Rust-first).
    pub fn label(&self) -> &'static str {
        match self {
            BoolFailureReason::OperandTooLarge { .. } => "OperandTooLarge",
            BoolFailureReason::EmptyOperand => "EmptyOperand",
            BoolFailureReason::DegenerateOperand => "DegenerateOperand",
            BoolFailureReason::NoBoundsOverlap => "NoBoundsOverlap",
            BoolFailureReason::KernelOutputInvalid => "KernelOutputInvalid",
            BoolFailureReason::SolidSolidDifferenceSkipped => "SolidSolidDifferenceSkipped",
            BoolFailureReason::PolygonalBoundedHalfSpaceFallback => {
                "PolygonalBoundedHalfSpaceFallback"
            }
            BoolFailureReason::CutterUnionUnavailable => "CutterUnionUnavailable",
            BoolFailureReason::UnknownBooleanOperator(_) => "UnknownBooleanOperator",
            BoolFailureReason::ManifoldOutputDegenerate { .. } => "ManifoldOutputDegenerate",
            BoolFailureReason::KernelError(_) => "KernelError",
            BoolFailureReason::DifferenceEmptiedHost => "DifferenceEmptiedHost",
        }
    }
}

impl fmt::Display for BoolFailureReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BoolFailureReason::OperandTooLarge { polys_a, polys_b } => write!(
                f,
                "operand polygon counts ({polys_a}, {polys_b}) exceed BSP cap"
            ),
            BoolFailureReason::EmptyOperand => f.write_str("operand mesh empty"),
            BoolFailureReason::DegenerateOperand => f.write_str("operand polygons degenerate"),
            BoolFailureReason::NoBoundsOverlap => f.write_str("operand bounds disjoint"),
            BoolFailureReason::KernelOutputInvalid => {
                f.write_str("CSG kernel output had non-finite vertices")
            }
            BoolFailureReason::SolidSolidDifferenceSkipped => {
                f.write_str("solid-vs-solid IfcBooleanResult.DIFFERENCE skipped (BSP unsafe)")
            }
            BoolFailureReason::PolygonalBoundedHalfSpaceFallback => f.write_str(
                "IfcPolygonalBoundedHalfSpace degraded to unbounded plane clip",
            ),
            BoolFailureReason::CutterUnionUnavailable => f.write_str(
                "cutter union not watertight; deferred to sequential per-cutter subtraction",
            ),
            BoolFailureReason::UnknownBooleanOperator(op) => {
                write!(f, "unknown IfcBooleanResult operator '{op}'")
            }
            BoolFailureReason::DifferenceEmptiedHost => f.write_str(
                "DIFFERENCE removed the entire host; reverted to un-cut",
            ),
            BoolFailureReason::ManifoldOutputDegenerate {
                host_tris,
                result_tris,
            } => write!(
                f,
                "Manifold difference returned implausibly small result ({result_tris} triangles from {host_tris}-triangle host) — fell back to BSP"
            ),
            BoolFailureReason::KernelError(msg) => write!(f, "kernel error: {msg}"),
        }
    }
}

/// Single boolean / CSG failure record.
///
/// `product_id` is optional because the CSG kernel itself doesn't know which
/// IFC product it's operating on — the router fills that in when it drains
/// failures after processing an element.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoolFailure {
    pub op: BoolOp,
    pub reason: BoolFailureReason,
    pub product_id: Option<u32>,
}

impl BoolFailure {
    pub fn new(op: BoolOp, reason: BoolFailureReason) -> Self {
        Self {
            op,
            reason,
            product_id: None,
        }
    }

    /// Attach an IFC product express ID. Used by the router after the CSG
    /// kernel returns, since the kernel itself is product-agnostic.
    pub fn with_product_id(mut self, product_id: u32) -> Self {
        self.product_id = Some(product_id);
        self
    }
}

impl fmt::Display for BoolFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.product_id {
            Some(id) => write!(f, "[product #{id}] {} failed: {}", self.op, self.reason),
            None => write!(f, "{} failed: {}", self.op, self.reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_includes_operands() {
        let f = BoolFailure::new(
            BoolOp::Difference,
            BoolFailureReason::OperandTooLarge {
                polys_a: 36,
                polys_b: 12,
            },
        );
        let rendered = f.to_string();
        assert!(rendered.contains("DIFFERENCE"));
        assert!(rendered.contains("36"));
        assert!(rendered.contains("12"));
    }

    #[test]
    fn with_product_id_attaches_id() {
        let f = BoolFailure::new(BoolOp::Union, BoolFailureReason::EmptyOperand)
            .with_product_id(12345);
        assert_eq!(f.product_id, Some(12345));
        assert!(f.to_string().contains("12345"));
    }

    #[test]
    fn solid_solid_skip_renders_meaningfully() {
        let f = BoolFailure::new(BoolOp::Difference, BoolFailureReason::SolidSolidDifferenceSkipped);
        let rendered = f.to_string();
        assert!(rendered.contains("solid-vs-solid"));
        assert!(rendered.contains("DIFFERENCE"));
    }
}
