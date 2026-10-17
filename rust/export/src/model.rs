// SPDX-License-Identifier: MPL-2.0
//! The export data model. It lives in `ifc_lite_processing::data_model` now
//! (C6-8, #7783): [`rows`](ifc_lite_processing::data_model::rows) streams it,
//! `inherit` merges type sets and `render::flat` encodes it for the flat
//! exporters. This module keeps the paths `ifc_lite_export::model::*` and
//! the crate root have always exported.

pub use ifc_lite_processing::data_model::rows::{
    build_export_model, build_export_model_with_options, fmt_num, stream_export_model,
    stream_export_model_with_index, stream_export_model_with_options, EntityRow, ExportModel,
    ModelOptions, Placement, PropValue, PropertySet, QuantitySet, QuantityValue, ValueKind,
};

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
