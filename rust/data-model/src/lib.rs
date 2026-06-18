// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared IFC data-model extraction + Parquet serialization.
//!
//! Extracted from `apps/server` so the native desktop backend
//! (`ifc-lite-desktop-server`) can serve the same data model the HTTP server
//! does — letting the browser skip its in-browser parse on the native path.
//! `extract_data_model` needs only `ifc-lite-core`; the Parquet serializer adds
//! `arrow`/`parquet`. The browser decodes the result with the existing
//! `serverDataModel.ts` consumer (same wire format as the HTTP server).

pub mod data_model;
pub mod parquet_data_model;

pub use data_model::*;
pub use parquet_data_model::*;
