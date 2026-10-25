// SPDX-License-Identifier: MPL-2.0
//! Processing chooses the ordered invocation; executors supply sealed receipts.
use super::{RetainedExecutionError, RetainedRequest};

pub(super) enum Operand<'a, R> {
    Source { receipt: &'a R, world_from_source: [f64; 16] },
    Placed { receipt: &'a R, world_from_object: [f64; 16] },
}

pub(super) enum Invocation<'a, R> {
    Construction(&'a RetainedRequest),
    Affine { input: &'a R, column_major: [f64; 16] },
    Boolean {
        left: Operand<'a, R>,
        right: Operand<'a, R>,
        operation: ifc_lite_geometry::BoolOp,
    },
}

#[derive(Clone, Copy)]
pub(super) struct NumericalLimits {
    pub chord_metres: f64,
    pub angle_degrees: f64,
    pub max_bytes: usize,
}

pub(super) trait RetainedRuntime {
    type Receipt: NumericalReceipt;
    fn domain(&self) -> <Self::Receipt as NumericalReceipt>::Domain;
    fn incarnation(&self) -> u64;
}

pub(super) trait RetainedExecutor: RetainedRuntime {
    fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits)
        -> Result<Self::Receipt, RetainedExecutionError>;
}

/// An executor borrowing one live Worker; no Send bound is needed on wasm32.
pub(super) trait AsyncRetainedExecutor: RetainedRuntime {
    fn invoke(&mut self, call: Invocation<'_, Self::Receipt>, limits: NumericalLimits)
        -> impl std::future::Future<Output = Result<Self::Receipt, RetainedExecutionError>>;
}

/// Read-only evidence from a sealed runtime receipt. These fields cannot create
/// a receipt or grant a lease; acceptance also checks its captured live domain.
pub(super) enum ReceiptEvidence<'a, K> {
    Construction(&'a ifc_lite_geometry::document::RetainedCompletion),
    Affine { input: K, column_major: &'a [f64; 16] },
    Boolean {
        operation: ifc_lite_geometry::BoolOp,
        left: K,
        right: K,
        world_from_left: &'a [f64; 16],
        world_from_right: &'a [f64; 16],
        world_from_evaluation: &'a [f64; 16],
        empty: bool,
    },
}

pub(super) trait NumericalReceipt {
    type Object: PartialEq;
    type Domain: ReceiptDomain;
    type Error: std::fmt::Display + std::fmt::Debug + Into<RetainedExecutionError>;
    fn heap_bytes() -> u64;
    fn object(&self) -> Self::Object;
    fn evidence(&self) -> ReceiptEvidence<'_, Self::Object>;
    fn domain(&self) -> &Self::Domain;
    fn validate_live(&self) -> Result<(), Self::Error>;
    fn belongs_to_domain(&self, domain: &Self::Domain) -> bool {
        self.domain().same_domain(domain)
    }
}

pub(super) trait ReceiptDomain: Clone {
    fn incarnation(&self) -> Option<u64>;
    fn retire(&self);
    fn same_domain(&self, other: &Self) -> bool;
}
