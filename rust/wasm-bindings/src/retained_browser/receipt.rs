// SPDX-License-Identifier: MPL-2.0
//! Sealed browser leases and immutable runtime evidence.
use super::*;
use ifc_lite_geometry::{document::RetainedTessellation, BoolOp};
use ifc_lite_processing::element::retained_runtime::{
    NumericalReceipt, ReceiptDomain, ReceiptEvidence,
};
use wasm_bindgen::JsValue;

pub enum BrowserReceipt {
    Construction(BrowserRealization),
    Affine {
        lease: Lease,
        input: JsValue,
        matrix: [f64; 16],
    },
    Boolean {
        lease: Lease,
        operation: BoolOp,
        left: JsValue,
        right: JsValue,
        world_left: [f64; 16],
        world_right: [f64; 16],
        mesh: Option<RetainedTessellation>,
    },
}

pub struct Lease {
    pub(super) domain: BrowserCancellation,
    pub(super) object: JsValue,
    pub(super) operations: usize,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.domain.owner.driver.release_object(&self.object);
    }
}
impl ReceiptDomain for BrowserCancellation {
    fn incarnation(&self) -> Option<u64> {
        self.owner.validate().ok().map(|()| self.owner.identity)
    }
    fn retire(&self) {
        self.owner.retire();
    }
    fn same_domain(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.owner, &other.owner)
    }
}

impl BrowserReceipt {
    pub(super) fn operations(&self) -> usize {
        match self {
            Self::Construction(_) => 0,
            Self::Affine { lease, .. } | Self::Boolean { lease, .. } => lease.operations,
        }
    }

    pub(super) fn mesh(&self) -> Option<&RetainedTessellation> {
        match self {
            Self::Construction(value) => Some(&value.completion.tessellation),
            Self::Boolean { mesh, .. } => mesh.as_ref(),
            Self::Affine { .. } => None,
        }
    }
}
impl NumericalReceipt for BrowserReceipt {
    type Object = JsValue;
    type Domain = BrowserCancellation;
    type Error = BrowserError;
    fn heap_bytes() -> u64 {
        std::mem::size_of::<Self>() as u64
    }
    fn buffer_bytes(&self) -> Result<u64, BrowserError> {
        let Some(mesh) = self.mesh() else {
            return Ok(0);
        };
        [
            (mesh.positions.capacity(), 8u64),
            (mesh.indices.capacity(), 4),
            (mesh.flat_corner_normals.capacity(), 8),
            (mesh.revision_local_faces.capacity(), 4),
        ]
        .into_iter()
        .try_fold(0u64, |sum, (count, width)| {
            (count as u64)
                .checked_mul(width)
                .and_then(|bytes| sum.checked_add(bytes))
                .ok_or(BrowserError::Exhausted)
        })
    }
    fn object(&self) -> JsValue {
        match self {
            Self::Construction(value) => value.object.clone(),
            Self::Affine { lease, .. } | Self::Boolean { lease, .. } => lease.object.clone(),
        }
    }
    fn domain(&self) -> &BrowserCancellation {
        match self {
            Self::Construction(value) => &value.domain,
            Self::Affine { lease, .. } | Self::Boolean { lease, .. } => &lease.domain,
        }
    }
    fn validate_live(&self) -> Result<(), BrowserError> {
        self.domain().owner.validate()?;
        if !self.domain().owner.driver.object_live(&self.object()) {
            return Err(BrowserError::WrongWorker);
        }
        Ok(())
    }
    fn evidence(&self) -> ReceiptEvidence<'_, JsValue> {
        match self {
            Self::Construction(value) => ReceiptEvidence::Construction(value.completion()),
            Self::Affine { input, matrix, .. } => ReceiptEvidence::Affine {
                input: input.clone(),
                column_major: matrix,
            },
            Self::Boolean {
                operation,
                left,
                right,
                world_left,
                world_right,
                mesh,
                ..
            } => ReceiptEvidence::Boolean {
                operation: *operation,
                left: left.clone(),
                right: right.clone(),
                world_from_left: world_left,
                world_from_right: world_right,
                world_from_evaluation: world_left,
                empty: mesh.is_none(),
            },
        }
    }
}
