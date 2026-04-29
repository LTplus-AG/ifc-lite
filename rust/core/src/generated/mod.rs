// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Auto-generated IFC Schema Types
//!
//! Generated from EXPRESS schema: IFC4X3_DEV_923b0514
//!
//! Note: The IfcType enum is renamed to FullIfcType to avoid conflicts
//! with the main schema::IfcType enum.

mod schema;
mod type_ids;

// Re-export type IDs (these are just constants, no conflict)
pub use type_ids::*;

// Re-export the generated IfcType directly (this is now the canonical schema)
pub use schema::IfcType;
