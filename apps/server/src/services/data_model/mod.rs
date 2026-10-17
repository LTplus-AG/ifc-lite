// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The data model the server serialises (properties, quantities, relationships,
//! materials, classifications, documents, spatial hierarchy).
//!
//! The extractors live in `ifc_lite_processing::data_model`, the one home of
//! the IFC data rows (C6, #7783); the Parquet writer in
//! `services/parquet_data_model*.rs` is the server's part.

pub use ifc_lite_processing::data_model::*;

#[cfg(test)]
#[path = "parquet_tests.rs"]
mod parquet_tests;
