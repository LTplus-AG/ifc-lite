// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! # IFC-Lite Clash
//!
//! High-performance geometry kernel for clash detection. This is a faithful
//! native port of the TypeScript reference engine in `packages/clash`: the same
//! AABB/vector math, triangle-triangle intersection (SAT) and minimum-distance
//! routines, per-element triangle BVHs, broad-phase candidate generation, and —
//! crucially — the exact narrow-phase classification.
//!
//! All geometric computation is performed in `f64`, even though vertices and
//! AABBs are sourced from `f32` buffers.
//!
//! ## Usage
//!
//! ```
//! use ifc_lite_clash::ClashSession;
//!
//! let mut session = ClashSession::new();
//! // positions: concatenated per-element vertex coords (x, y, z, ...)
//! // pos_ranges: [float_offset, float_len] per element
//! // indices: concatenated per-element LOCAL triangle indices
//! // idx_ranges: [idx_offset, idx_len] per element
//! // aabbs: [minx, miny, minz, maxx, maxy, maxz] per element
//! session.ingest(&[], &[], &[], &[], &[]);
//! let result = session.run_rule(&[], &[], 0, 0.0, 0.0, false);
//! assert!(result.records.is_empty());
//! ```

mod aabb;
mod bvh;
mod narrow;
mod triangle;
mod tri_mesh;
mod vec3;
mod session;

pub use aabb::Aabb;
pub use narrow::ClashStatus;
pub use session::{ClashRecord, ClashSession, RuleResult};

#[cfg(test)]
mod tests;
