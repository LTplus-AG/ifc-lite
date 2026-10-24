// SPDX-License-Identifier: MPL-2.0
//! Runtime-neutral numerical provenance, separate from object leases and IFC face identity.
use super::{RetainedRequest, retained_affine::AffineCertificate};
use std::sync::Arc;

/// Maximum admitted combined affine/Boolean operation count.
pub const MAX_OPERATIONS: usize = 128;

/// Numerical Boolean selector; wire codes are fixed by the adapter ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOperation {
    Union,
    Intersection,
    Difference,
}

/// The evaluated operations behind a result, separate from revision-local SDK
/// faces and display data. It records numerical provenance, not complete
/// representation coverage.
#[derive(Debug, Clone)]
pub enum RetainedLineage {
    PlaneClip {
        input: Arc<Self>, plane: [f64; 6],
        side: super::retained_plane::PlaneSide, mode: super::retained_plane::PlaneClipMode,
        world_from_evaluation: [f64; 16], certificate: Arc<super::retained_plane::PlaneCertificate>,
    },
    Source {
        request: Box<RetainedRequest>,
        world_from_source: [f64; 16],
    },
    Boolean {
        operation: BooleanOperation,
        left: Arc<Self>,
        right: Arc<Self>,
    },
    /// A realization's raw authored source in its own evaluation frame, as
    /// the input of an affine copy (no world placement applies to it).
    Definition {
        request: Box<RetainedRequest>,
        source_from_evaluation: [f64; 16],
        evaluation_from_source: [f64; 16],
    },
    /// A bounded affine copy of `input`, in the input's evaluation frame.
    AffineCopy {
        input: Arc<Self>,
        column_major: [f64; 16],
        certificate: AffineCertificate,
    },
    /// An explicit rigid placement of a copied value or reused Boolean result.
    Placed {
        value: Arc<Self>,
        world_from_evaluation: [f64; 16],
    },
}
