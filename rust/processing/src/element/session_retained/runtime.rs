// SPDX-License-Identifier: MPL-2.0
//! Processing chooses the ordered invocation; executors supply sealed receipts.
use super::{protocol, ReceiptFailure, RetainedExecutionError, RetainedRequest};

pub enum Operand<'a, R> {
    Source {
        receipt: &'a R,
        world_from_source: [f64; 16],
    },
    Placed {
        receipt: &'a R,
        world_from_object: [f64; 16],
    },
}

pub enum Invocation<'a, R> {
    Construction(&'a RetainedRequest),
    Affine {
        input: &'a R,
        column_major: [f64; 16],
    },
    Boolean {
        left: Operand<'a, R>,
        right: Operand<'a, R>,
        operation: ifc_lite_geometry::BoolOp,
    },
}

#[derive(Clone, Copy)]
pub struct NumericalLimits {
    pub chord_metres: f64,
    pub angle_degrees: f64,
    pub max_bytes: usize,
}
impl NumericalLimits {
    pub(super) fn validate(self) -> Result<(), RetainedExecutionError> {
        if !self.chord_metres.is_finite()
            || self.chord_metres <= 0.
            || !self.angle_degrees.is_finite()
            || self.angle_degrees <= 0.
            || self.angle_degrees > 180.
            || self.max_bytes == 0
        {
            return Err(protocol(ReceiptFailure::InvalidRetainedNumericalLimits));
        }
        Ok(())
    }
}

pub trait RetainedRuntime {
    type Receipt: NumericalReceipt;
    fn domain(&self) -> <Self::Receipt as NumericalReceipt>::Domain;
    fn incarnation(&self) -> u64;
}

/// An executor borrowing one live Worker; no Send bound is needed on wasm32.
pub trait AsyncRetainedExecutor: RetainedRuntime {
    fn invoke(
        &mut self,
        call: Invocation<'_, Self::Receipt>,
        limits: NumericalLimits,
    ) -> impl std::future::Future<Output = Result<Self::Receipt, RuntimeFault>>;
}

/// Read-only evidence from a sealed runtime receipt. These fields cannot create
/// a receipt or grant a lease; acceptance also checks its captured live domain.
pub enum ReceiptEvidence<'a, K> {
    Construction(&'a ifc_lite_geometry::document::RetainedCompletion),
    Affine {
        input: K,
        column_major: &'a [f64; 16],
    },
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

/// Borrowed object-local metre mesh from a sealed numerical receipt.
pub struct ReceiptMesh<'a> {
    pub positions: &'a [f64],
    pub indices: &'a [u32],
}

pub trait NumericalReceipt {
    type Object: PartialEq;
    type Domain: ReceiptDomain;
    type Error: std::fmt::Display + std::fmt::Debug + Into<RuntimeFault>;
    fn heap_bytes() -> u64;
    /// Actual returned buffer capacities; SDK object memory is opaque.
    fn buffer_bytes(&self) -> Result<u64, Self::Error>;
    /// Affine-only receipts deliberately have no mesh in M1.
    fn mesh(&self) -> Option<ReceiptMesh<'_>> {
        None
    }
    fn object(&self) -> Self::Object;
    fn evidence(&self) -> ReceiptEvidence<'_, Self::Object>;
    fn domain(&self) -> &Self::Domain;
    fn validate_live(&self) -> Result<(), Self::Error>;
    fn belongs_to_domain(&self, domain: &Self::Domain) -> bool {
        self.domain().same_domain(domain)
    }
}

pub trait ReceiptDomain: Clone {
    fn incarnation(&self) -> Option<u64>;
    fn retire(&self);
    fn same_domain(&self, other: &Self) -> bool;
}

/// Target-neutral fault returned by external executors and numerical receipts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeFault {
    pub(super) kind: RuntimeFaultKind,
    pub(super) message: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RuntimeFaultKind {
    Kernel { status: i32 },
    Unqualified,
    Retired,
    ResourceLimit,
    Transport,
    /// The runtime itself is healthy, but the request or its reply broke the
    /// executor contract (bad argument, unsupported operator, receipt mismatch).
    Contract,
}
impl RuntimeFault {
    pub fn kernel(status: i32, message: impl Into<String>) -> Self {
        Self {
            kind: RuntimeFaultKind::Kernel { status },
            message: message.into(),
        }
    }
    pub fn unqualified(message: impl Into<String>) -> Self {
        Self {
            kind: RuntimeFaultKind::Unqualified,
            message: message.into(),
        }
    }
    pub fn retired(message: impl Into<String>) -> Self {
        Self {
            kind: RuntimeFaultKind::Retired,
            message: message.into(),
        }
    }
    pub fn resource_limit(message: impl Into<String>) -> Self {
        Self {
            kind: RuntimeFaultKind::ResourceLimit,
            message: message.into(),
        }
    }
    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: RuntimeFaultKind::Transport,
            message: message.into(),
        }
    }
    /// A contract breach the runtime detected; the worker stays usable.
    pub fn contract(message: impl Into<String>) -> Self {
        Self {
            kind: RuntimeFaultKind::Contract,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for RuntimeFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for RuntimeFault {}
impl From<RuntimeFault> for RetainedExecutionError {
    fn from(fault: RuntimeFault) -> Self {
        Self::Runtime(fault)
    }
}
