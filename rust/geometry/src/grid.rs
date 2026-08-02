// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared float-noise-tolerance quantisation constants used by more than one
//! geometry pass. Single-sourced so two independently-evolving passes (e.g. a
//! weld and the plane-bucketing it feeds) can never drift apart on the SAME
//! tolerance — see `kernel::mesh_bridge::SNAP_GRID` for the kernel's own
//! canonical snap grid (that one stays defined in `kernel::mesh_bridge`, since
//! it is already the kernel's documented canonical constant).

/// Normal-direction quantisation grid (`f64`): a normal component is
/// multiplied by this and rounded to an integer before bucketing/keying. 1e3
/// gives ~0.057° resolution. Shared by `facet_weld`'s per-facet plane
/// clustering and `csg::consolidate`'s plane-bucket key, so a bucket boundary
/// can never disagree between the two passes.
pub(crate) const NORMAL_QUANT_F64: f64 = 1.0e3;

/// Same quantisation grid as [`NORMAL_QUANT_F64`], as `f32` for callers
/// (`mesh_weld`) that key directly off `Mesh`'s f32 normals.
pub(crate) const NORMAL_QUANT_F32: f32 = 1.0e3;
