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
//! to (not instead of) the existing fallback. Sprint 2's Manifold migration
//! and Sprint 1's regression tests both rely on these records.

use std::fmt;

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
    /// At least one operand exceeded the BSP CSG polygon cap.
    /// Caller fell back to the un-cut host (DIFFERENCE/UNION) or empty (INTERSECTION).
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
    /// Solid-vs-solid `IfcBooleanResult.DIFFERENCE` was not attempted.
    /// The legacy BSP can stack-overflow on arbitrary solid combinations,
    /// so until Manifold lands we return the first operand un-cut.
    SolidSolidDifferenceSkipped,
    /// `IfcPolygonalBoundedHalfSpace` prism-subtraction failed; the kernel
    /// fell back to an unbounded plane clip, silently dropping the polygonal
    /// boundary. The clip *is* applied but is a strict superset of the
    /// requested cut.
    PolygonalBoundedHalfSpaceFallback,
    /// `IfcBooleanResult` operator string didn't match any known op.
    UnknownBooleanOperator(String),
    /// Catch-all for kernel-specific errors. Free-form because the legacy BSP
    /// returns `String` errors and Manifold (Sprint 2) will return its own.
    KernelError(String),
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
            BoolFailureReason::UnknownBooleanOperator(op) => {
                write!(f, "unknown IfcBooleanResult operator '{op}'")
            }
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
