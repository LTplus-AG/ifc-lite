// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The per-entity geometry-fingerprint surface of [`MeshCollection`]: five
//! index-parallel arrays (id, hash, world AABB, volume, closure flags) and the
//! one call that appends to all of them together.
//!
//! A CHILD module of `mesh`, so it reads that module's private
//! `MeshCollection` fields without widening them. Split out because the
//! contract these arrays carry — what a `NaN` means, why a volume is usually
//! absent, what each closure bit diagnoses — is most of their weight, and
//! `mesh.rs` is the mesh buffer's home, not the diff engine's.
//!
//! THE INVARIANT, once: every array has one entry (or one fixed-width span) per
//! `geometry_hash_ids` entry, always. An absent value is written as `NaN`, never
//! skipped — a short array would mis-attribute every entry past the gap, and the
//! consumer reads purely by index.

use super::MeshCollection;
use crate::zero_copy::frame_swap::swap_zup_to_yup_aabb;
use wasm_bindgen::prelude::*;

/// Everything one hashing pass learned about one entity, pushed as a unit.
///
/// A struct rather than five positional arguments precisely BECAUSE of the
/// index-parallel invariant: there is one push site per entity, and a
/// positional call cannot be given three of five values in the wrong order or
/// silently drop one.
pub struct GeometryFingerprint {
    pub express_id: u32,
    /// The #924 winding-invariant shape fingerprint.
    pub hash: u64,
    /// World AABB `[minx, miny, minz, maxx, maxy, maxz]`, or `None` → six NaNs.
    /// Stays in the producer's IFC Z-up frame; the getter converts it to the
    /// viewer's Y-up (see [`MeshCollection::geometry_aabb_values`]).
    pub aabb: Option<[f64; 6]>,
    /// Enclosed volume in m³, `None` (→ NaN) unless the geometry was provably a
    /// single closed orientable solid. See `ifc_lite_geometry::GeometryHasher::volume`.
    pub volume: Option<f64>,
    /// Packed `ifc_lite_geometry::GeometryClosure` verdict.
    pub closure_bits: u8,
}

#[wasm_bindgen]
impl MeshCollection {
    /// Express ids for the per-entity geometry fingerprints, parallel to
    /// [`Self::geometry_hash_values`]. Empty unless geometry hashing was
    /// enabled via `IfcAPI.setComputeGeometryHashes`.
    #[wasm_bindgen(getter, js_name = geometryHashIds)]
    pub fn geometry_hash_ids(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(&self.geometry_hash_ids[..])
    }

    /// Per-entity geometry fingerprints as a `BigUint64Array`, parallel to
    /// [`Self::geometry_hash_ids`]. `u64` is exposed (not hex strings) so JS
    /// can compare with `===` and key maps without allocation. Empty unless
    /// geometry hashing was enabled.
    #[wasm_bindgen(getter, js_name = geometryHashValues)]
    pub fn geometry_hash_values(&self) -> js_sys::BigUint64Array {
        js_sys::BigUint64Array::from(&self.geometry_hash_values[..])
    }

    /// Per-entity world-space AABBs as a `Float64Array`, SIX values per entry
    /// (`minx, miny, minz, maxx, maxy, maxz`), in the same order as
    /// [`Self::geometry_hash_ids`] — entry `i` spans `[6*i, 6*i+6)`. Empty
    /// unless geometry hashing was enabled; the same
    /// `IfcAPI.setComputeGeometryHashes` switch gates both, so nothing is
    /// computed when the diff feature is off.
    ///
    /// Unquantized world `f64` (the file's RTC folded back in), so two
    /// revisions that chose different RTC offsets report the same box. This is
    /// what lets a consumer say "MOVED" honestly instead of inferring it from a
    /// changed hash, which also fires on reshape and on retriangulation.
    ///
    /// **Frame: WebGL Y-up**, like every other box, position, origin and
    /// placement that crosses this boundary (see `MeshDataJs::local_bounds`).
    /// The hasher accumulates in the producer's IFC Z-up frame, so the swap
    /// `(x,y,z) -> (x,z,-y)` is applied here, on the way out. Unconverted, the
    /// boxes would not enclose the very meshes `processGeometryBatch` returns
    /// alongside them. Positions are RTC-relative and this box is absolute, so
    /// a consumer comparing the two folds `rtcOffset*` in — itself Y-up-swapped.
    ///
    /// Present for every hashed entity. Its companion
    /// [`Self::geometry_volume_values`] is not — see there.
    #[wasm_bindgen(getter, js_name = geometryAabbValues)]
    pub fn geometry_aabb_values(&self) -> js_sys::Float64Array {
        // `push_geometry_hash` is the only writer and always extends by exactly
        // six, so `chunks_exact` drops nothing. NaN placeholders (hash without a
        // box) survive the swap as NaN, since `-NaN` is NaN.
        let y_up: Vec<f64> = self
            .geometry_aabb_values
            .chunks_exact(6)
            .flat_map(|b| swap_zup_to_yup_aabb([b[0], b[1], b[2], b[3], b[4], b[5]]))
            .collect();
        js_sys::Float64Array::from(&y_up[..])
    }

    /// Per-entity enclosed volume in CUBIC METRES as a `Float64Array`, one
    /// value per entry in [`Self::geometry_hash_ids`] order. `NaN` means NO
    /// TRUSTWORTHY VOLUME — the same absent convention as
    /// [`Self::geometry_aabb_values`] — and it is `NaN` for roughly a third of
    /// entities by design, not by failure.
    ///
    /// A value is emitted only when that entity's produced geometry was
    /// PROVABLY a single closed, orientable, single-component solid, as decided
    /// by the mesher's own orientation pass. Read
    /// `ifc_lite_geometry::GeometryHasher::volume` before treating a `NaN` as a
    /// bug: an open `SurfaceModel`, a material-layered wall (whose slices are
    /// open bands by construction), and any element assembled from more than one
    /// representation item all correctly report nothing rather than a plausible
    /// wrong number. [`Self::geometry_closure_flags`] says which.
    ///
    /// This is NOT a substitute for an IFC `BaseQuantities` `GrossVolume`: it is
    /// the volume of the geometry that was actually meshed, after opening cuts,
    /// and it says nothing about whether a CSG degradation left the host uncut
    /// (see the `diagnostics` getter).
    #[wasm_bindgen(getter, js_name = geometryVolumeValues)]
    pub fn geometry_volume_values(&self) -> js_sys::Float64Array {
        js_sys::Float64Array::from(&self.geometry_volume_values[..])
    }

    /// Per-entity topology verdict as a `Uint8Array`, one packed byte per entry
    /// in [`Self::geometry_hash_ids`] order:
    ///
    /// * bit 0 (`1`) — every segment closed (no boundary / non-manifold edge)
    /// * bit 1 (`2`) — every segment orientable
    /// * bit 2 (`4`) — every segment a single connected component
    /// * bit 3 (`8`) — the entity produced exactly one segment
    ///
    /// `0x0F` is exactly the set that carries a volume in
    /// [`Self::geometry_volume_values`]. The individual bits are the diagnosis:
    /// a model checker can distinguish "this wall is an open shell" (bit 0
    /// clear) from "this door is a multi-item assembly whose parts may overlap"
    /// (bit 3 clear), which are different findings with different fixes.
    #[wasm_bindgen(getter, js_name = geometryClosureFlags)]
    pub fn geometry_closure_flags(&self) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(&self.geometry_closure_flags[..])
    }
}

impl MeshCollection {
    /// Record one entity's geometry fingerprint and everything the SAME hashing
    /// pass measured about it. Taken as a struct rather than five positional
    /// arguments precisely because the five arrays must stay index-parallel:
    /// there is one push site per entity, and a caller cannot supply three of
    /// the five and silently misalign every later entry.
    ///
    /// Absent values are written in place, never skipped — `None` becomes a
    /// six-`NaN` box / a `NaN` volume — because shortening an array would
    /// mis-attribute every entry past it.
    #[inline]
    pub fn push_geometry_hash(&mut self, fp: GeometryFingerprint) {
        self.geometry_hash_ids.push(fp.express_id);
        self.geometry_hash_values.push(fp.hash);
        self.geometry_aabb_values
            .extend_from_slice(&fp.aabb.unwrap_or([f64::NAN; 6]));
        self.geometry_volume_values.push(fp.volume.unwrap_or(f64::NAN));
        self.geometry_closure_flags.push(fp.closure_bits);
    }
}
