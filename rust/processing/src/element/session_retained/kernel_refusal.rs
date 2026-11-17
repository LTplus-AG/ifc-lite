// SPDX-License-Identifier: MPL-2.0
//! #7955: a kernel status the worker reported over its protocol is this product's typed
//! refusal. It says nothing about the next product, so it must not spend the restarts that
//! recover real faults: ISSUE_098 and advanced_model reached the cap of three on such
//! refusals, and 11175 later products were refused unbuilt, 10430 of which publish.
use super::{runtime::RuntimeFaultKind, RetainedExecutionError};

/// Kernel statuses the adapter defines; any other, and transport loss, stay faults.
pub(super) fn is_typed_status(status: i32) -> bool { (1..=7).contains(&status) }
/// Whether this outcome is a typed kernel refusal, not a lost or misbehaving worker.
pub(super) fn is_typed_refusal(error: &RetainedExecutionError) -> bool {
    match error {
        RetainedExecutionError::Runtime(fault) => matches!(fault.kind, RuntimeFaultKind::Kernel { status } if is_typed_status(status)),
        RetainedExecutionError::Opening { inner, .. } => is_typed_refusal(inner),
        _ => false,
    }
}
