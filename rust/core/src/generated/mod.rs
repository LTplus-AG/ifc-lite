// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Auto-generated IFC Schema Types
//!
//! Generated from EXPRESS schema: IFC4X3_DEV_923b0514
//!
//! Note: The IfcType enum is renamed to FullIfcType to avoid conflicts
//! with the main schema::IfcType enum.

mod ifc2x3;
mod ifc4;
mod ifc4x1;
mod ifc4x2;
pub mod legacy_attribute_names;
mod schema;
pub(crate) mod schema_registry;
mod type_ids;

// Re-export type IDs (these are just constants, no conflict)
pub use type_ids::*;

// Re-export the generated IfcType directly (this is now the canonical schema)
pub use schema::{IfcType, ALL as IFC_TYPES};
pub use schema_registry::{
    attribute_names_for_schema, entity_info_for_schema, is_subtype_of_for_schema, SchemaEntityInfo,
};
