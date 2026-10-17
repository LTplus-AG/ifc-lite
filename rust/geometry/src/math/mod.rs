// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The cross-crate math home: vectors, 4x4 matrices, AABBs and the Z-up to
//! Y-up frame, over plain arrays (#7772, charter #7670), plus the plane kit
//! [`v2`] and its exact predicates (`geom2d`, #7773).
//!
//! `nalgebra` stays geometry's interior type. Every cross-crate signature is
//! already an array (`InstanceMeta.transform`, `origin`, `local_bounds`), so
//! this module speaks `[f64; 3]` and row-major `[f64; 16]`, with exact bridges
//! to `Matrix4<f64>` in [`mat4`]. The one struct is [`aabb::Aabb3`], because a
//! box carries an invariant (the empty sentinel, well-formedness) that a tuple
//! cannot.
//!
//! # Conventions (the contract the tests pin)
//!
//! - **f64 throughout.** f32 appears only at the named boundary casts
//!   ([`mat4::to_f32`], [`mat4::to_col_major_f32`]) and in the exact widening
//!   [`aabb::Aabb3::from_f32_positions`].
//! - **Row-major** `[f64; 16]` (`m[r * 4 + c]`). A column-major array enters
//!   only through [`mat4::transpose`], [`mat4::col_major_array`] or
//!   [`mat4::transform_vector`]'s documented `Mᵀ·v` identity.
//! - **No FMA, no `mul_add`.** Every sum is written out left to right
//!   (`a0*b0 + a1*b1 + a2*b2`). The operation order is part of the contract:
//!   `mesh_determinism` and the corpus fingerprints pin outputs that pass
//!   through these functions, and the kernel relies on it.
//! - **NaN behaviour is stated per function.** `min`/`max` folds skip NaN
//!   (`f64::min`), `normalize` refuses a non-finite length.
//! - **Thresholds are arguments.** `normalize` takes its `min_len`; the
//!   values callers pass are named, with units, in [`tol`] (F2c, #7774).

pub mod aabb;
pub mod frame;
pub(crate) mod geom2d;
pub mod mat4;
pub(crate) mod normals;
pub mod v2;
pub mod v3;
pub mod tol;

#[cfg(test)]
mod aabb_tests;
#[cfg(test)]
mod canonical_parity_tests;
#[cfg(test)]
mod frame_tests;
#[cfg(test)]
mod mat4_tests;
#[cfg(test)]
mod normals_tests;
#[cfg(test)]
mod v2_tests;
#[cfg(test)]
mod v3_tests;
#[cfg(test)]
mod tol_tests;
