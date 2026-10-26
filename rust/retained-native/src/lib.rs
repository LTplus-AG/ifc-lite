// SPDX-License-Identifier: MPL-2.0
//! Opt-in native executor. No SMLib dependency enters published processing.
#![cfg(all(feature = "retained-runtime", not(target_arch = "wasm32")))]
mod model;
mod timing;
pub use timing::NativeTimings;
mod native_types;
mod runtime_native;
mod runtime_receipt_native;
pub use ifc_lite_processing::element::retained_runtime::{
    ModelOptions, ModelSummary, PresentationObligationsUnmet, ProductBudgetSpec, ProductOutcome,
    ShapeOnlyProduct, ShapePart,
};
pub use model::{block_on, run_model_native, run_model_native_timed, NativeModelDriver};
pub use native_types::{NativeDomain, NativeReceipt, NativeWorker};
