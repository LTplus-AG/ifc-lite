// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The geometry pass: the canonical native `process`, and the conversion of
//! its meshes and frame into what the cache stores.
//!
//! Nothing here meshes anything: every vertex comes from
//! `ifc_lite_processing::process`, changed only by
//!
//! - the site rotation the pass removed, put back (`IfcSite`-local tier with
//!   a rotating site placement only; see [`SiteRotation`]), and
//! - the one IFC Z-up to viewer Y-up swap the browser path applies
//!   (`MeshDataJs::new` in `rust/wasm-bindings`), through the same
//!   `ifc_lite_geometry::math::frame` functions.
//!
//! The reader places a vertex at `yUp⁻¹(origin + position) + wasmRtcOffset`
//! (`CoordinateInfo.wasmRtcOffset` is a translation and nothing else;
//! `buildingRotation` orients camera presets and section planes and is never
//! applied to geometry), so that has to equal `MeshFrame::to_world` of the
//! pass-frame point for every tier.
//!
//! Two shapes of the same pass. [`run_retained`] is one job chunk with every
//! mesh retained, as slice 2 shipped it. [`run_streaming`] chunks the jobs and
//! retains nothing: each emitted batch is converted and handed on, then
//! dropped. Neither changes what is meshed or the order it is emitted in
//! (file order, `fast_first` off in both), and with `fast_first` off no
//! style is deferred, so no colour correction can arrive after its mesh.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ifc_lite_geometry::math::frame::{
    aabb_zup_to_yup, conjugate_zup_to_yup, zup_to_yup, zup_to_yup_in_place,
};
use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{
    process, Batching, FrameEvent, MeshData, MeshFrame, ProcessingRequest, ProcessingResult, ProcessingSink,
};

use crate::geometry::coordinate_info::CoordinateInfo;
use crate::geometry::record::CacheMesh;
use crate::CacheError;

/// The frame metadata the head needs once the pass is done. Bounds are left
/// to the section writer, which sees every mesh.
pub(crate) struct Pass {
    pub(crate) coordinate_info: CoordinateInfo,
    pub(crate) schema: &'static str,
}

/// Material-layer slicing on, as on the browser path the cache normally comes
/// from; the first-frame property and layer resolution off, since no record
/// carries either.
fn request(batching: Batching, retain: bool) -> ProcessingRequest {
    let features = ifc_lite_processing::Features::default()
        .properties(false)
        .presentation_layers(false)
        .finishes(true);
    ProcessingRequest::default()
        .batching(batching)
        .layer_slicing(true)
        .retain_meshes(retain)
        .features(features)
}

/// Collects the finishes and the colour corrections of a retained pass.
#[derive(Default)]
struct Collector {
    finishes: Vec<Option<SpecularMaterial>>,
    colors: HashMap<u32, [f32; 4]>,
}

impl ProcessingSink for Collector {
    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        self.finishes.extend_from_slice(finishes);
    }

    fn on_color_update(&mut self, updates: &[(u32, [f32; 4])]) {
        for (express_id, color) in updates {
            self.colors.insert(*express_id, *color);
        }
    }
}

/// One job chunk, every mesh retained, then each handed to `each` in emit
/// order.
pub(crate) fn run_retained(
    source: &[u8],
    mut each: impl FnMut(CacheMesh) -> Result<(), CacheError>,
) -> Result<Pass, CacheError> {
    let mut collector = Collector::default();
    let mut result = process(source, &request(Batching::single_chunk(), true), &mut collector);
    let rotation = SiteRotation::removed_by(result.frame);
    let meshes = std::mem::take(&mut result.meshes);
    for (at, mut mesh) in meshes.into_iter().enumerate() {
        let finish = collector.finishes.get(at).copied().flatten();
        let color = collector.colors.get(&mesh.express_id).copied();
        let arrays = (
            std::mem::take(&mut mesh.positions),
            std::mem::take(&mut mesh.normals),
            std::mem::take(&mut mesh.indices),
        );
        each(to_cache_mesh(&mesh, arrays, finish, color, rotation))?;
    }
    Ok(finish_pass(source, &result))
}

/// Hands each batch to `each` as it is emitted, holding no mesh past it. The
/// first error cancels the pass and is returned.
struct Streamer<F> {
    each: F,
    /// Set by `on_frame`, which fires once before the first batch.
    rotation: Option<SiteRotation>,
    finishes: Vec<Option<SpecularMaterial>>,
    error: Option<CacheError>,
    cancel: Arc<AtomicBool>,
}

impl<F: FnMut(CacheMesh) -> Result<(), CacheError>> ProcessingSink for Streamer<F> {
    fn on_frame(&mut self, event: &FrameEvent) {
        // The same frame the retained path reads off `result.frame`, known
        // before any batch, so every streamed mesh is restored identically.
        self.rotation = SiteRotation::removed_by(event.frame);
    }

    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        // Always immediately before the `on_batch` they align with.
        self.finishes.clear();
        self.finishes.extend_from_slice(finishes);
    }

    fn on_batch(&mut self, meshes: &[MeshData], _processed: usize, _total: usize) {
        if self.error.is_some() {
            return;
        }
        for (at, mesh) in meshes.iter().enumerate() {
            let finish = self.finishes.get(at).copied().flatten();
            let arrays = (mesh.positions.clone(), mesh.normals.clone(), mesh.indices.clone());
            if let Err(error) = (self.each)(to_cache_mesh(mesh, arrays, finish, None, self.rotation)) {
                self.error = Some(error);
                self.cancel.store(true, Ordering::Relaxed);
                return;
            }
        }
    }

    fn on_color_update(&mut self, _updates: &[(u32, [f32; 4])]) {
        // Only a `fast_first` pass defers styles, and this one is not; were it
        // to, the meshes it corrects would already be spooled.
        self.error.get_or_insert(CacheError::Io {
            context: "geometry pass".to_owned(),
            source: std::io::Error::other("deferred colour update after its meshes were written"),
        });
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// `batch_jobs` jobs per chunk, nothing retained: peak mesh memory is one job
/// chunk's meshes plus whatever `each` keeps.
pub(crate) fn run_streaming(
    source: &[u8],
    batch_jobs: usize,
    each: impl FnMut(CacheMesh) -> Result<(), CacheError>,
) -> Result<Pass, CacheError> {
    let cancel = Arc::new(AtomicBool::new(false));
    let request = request(Batching::new(batch_jobs, batch_jobs), false).cancel(cancel.clone());
    let mut streamer = Streamer { each, rotation: None, finishes: Vec::new(), error: None, cancel };
    let result = process(source, &request, &mut streamer);
    debug_assert!(result.meshes.is_empty(), "retain_meshes is off");
    match streamer.error {
        Some(error) => Err(error),
        None => Ok(finish_pass(source, &result)),
    }
}

fn finish_pass(source: &[u8], result: &ProcessingResult) -> Pass {
    Pass { coordinate_info: coordinate_info(result), schema: ifc_lite_processing::detect_schema_version(source) }
}

/// The site rotation `R` a [`MeshFrame::SiteLocal`] pass took out of its
/// vertices (`Rᵀ · (P − t)`), to put back before the Y-up swap.
///
/// `wasmRtcOffset` can only carry the translation `t`, so the writer restores
/// `R` into the stored values themselves, in f64 and through the frame's own
/// [`MeshFrame::direction_mapper`] (the `R ·` half of
/// [`MeshFrame::to_world`], `rotate_and_translate` with a zero offset):
///
/// - origin′ = `R · origin` in f64, positions′ = `f32(R · f64(p))` per
///   vertex, normals′ = `f32(R · f64(n))`. World is then
///   `R · origin + R · p + t = MeshFrame::to_world(origin + p)`, with `t`
///   still in `wasmRtcOffset`.
/// - No precision is lost: `p` is small (relative to the f64 origin and the
///   f64 RTC), and a rotation preserves its length, so `R · p` rounds to f32
///   at the same scale `p` already did. The large parts never meet an f32.
///   The alternative of folding `R · p` into an f64 origin needs one origin
///   per vertex, which a record does not have.
/// - `localToWorld` is NOT composed with `R`: the pass captures it before the
///   bake, in IFC world axes and pre-RTC (`MeshData::local_to_world`), which
///   is the frame the restored vertices are in. The pass also drops it, and
///   `localBounds`, whenever a site rotation was removed
///   (`site_local_rotation_invalidates_captured_transforms`), so both pass
///   through as they came. Bounds and chunk AABBs follow from the restored
///   positions.
///
/// `None` when the pass removed no rotation, so those tiers store exactly
/// what they did before (no f32 → f64 → f32 round trip at all).
#[derive(Clone, Copy)]
struct SiteRotation(MeshFrame);

impl SiteRotation {
    /// `MeshFrame::world_matrix`'s linear block is the columns
    /// `rotate_out_of_frame(e_i)`, which return `e_i` untouched exactly when
    /// the frame removed no rotation (the `rotation_is_identity` rule the bake
    /// itself used), and differ from it otherwise.
    fn removed_by(frame: MeshFrame) -> Option<Self> {
        let world = frame.world_matrix();
        let identity = (0..3).all(|c| (0..3).all(|r| world[c * 4 + r] == if c == r { 1.0 } else { 0.0 }));
        (!identity).then_some(Self(frame))
    }

    fn point(self, p: [f64; 3]) -> [f64; 3] {
        (self.0.direction_mapper())(p)
    }

    fn restore_in_place(self, values: &mut [f32]) {
        let rotate = self.0.direction_mapper();
        for xyz in values.chunks_exact_mut(3) {
            let v = rotate([f64::from(xyz[0]), f64::from(xyz[1]), f64::from(xyz[2])]);
            xyz[0] = v[0] as f32;
            xyz[1] = v[1] as f32;
            xyz[2] = v[2] as f32;
        }
    }
}

fn to_cache_mesh(
    mesh: &MeshData,
    (mut positions, mut normals, indices): (Vec<f32>, Vec<f32>, Vec<u32>),
    finish: Option<SpecularMaterial>,
    color: Option<[f32; 4]>,
    rotation: Option<SiteRotation>,
) -> CacheMesh {
    let mut origin = mesh.origin;
    if let Some(rotation) = rotation {
        rotation.restore_in_place(&mut positions);
        rotation.restore_in_place(&mut normals);
        origin = rotation.point(origin);
    }
    zup_to_yup_in_place(&mut positions);
    zup_to_yup_in_place(&mut normals);
    CacheMesh {
        express_id: mesh.express_id,
        ifc_type: mesh.ifc_type.clone(),
        positions,
        normals,
        indices,
        color: color.unwrap_or(mesh.color),
        geometry_class: mesh.geometry_class,
        geometry_item_id: mesh.geometry_item_id,
        material_id: mesh.material_id,
        origin: stored_origin(zup_to_yup(origin)),
        metallic: finish.and_then(|f| f.metallic),
        roughness: finish.and_then(|f| f.roughness),
        shading_color: None,
        local_bounds: mesh.local_bounds.map(aabb_zup_to_yup),
        local_to_world: mesh.local_to_world.map(|m| conjugate_zup_to_yup(&m)),
    }
}

/// An all-zero origin is "absent" to the reader (`if (ox || oy || oz)`), and
/// the TS writer encodes an absent origin as `+0` three times. The swap turns
/// a native `[0, 0, 0]` into `[0, 0, -0]` (it never folds the sign of zero),
/// so the absent value is written in that one canonical spelling; a non-zero
/// origin keeps its exact bits.
fn stored_origin(origin: [f64; 3]) -> [f64; 3] {
    if origin.iter().all(|axis| *axis == 0.0) {
        [0.0; 3]
    } else {
        origin
    }
}

/// Everything but the bounds, from the pass's frame and metadata.
fn coordinate_info(result: &ProcessingResult) -> CoordinateInfo {
    let frame = result.frame;
    let (x, y, z) = frame.rtc_offset();
    let shifted = frame.needs_shift();
    let site_origin = result
        .site_transform
        .as_deref()
        .filter(|_| result.metadata.length_unit_refused.is_none())
        .filter(|m| m.len() == 16)
        .map(|m| [m[12], m[13], m[14]])
        .filter(|origin| origin.iter().all(|v| v.is_finite()));
    CoordinateInfo {
        has_large_coordinates: shifted,
        wasm_rtc_offset: shifted.then_some([x, y, z]),
        length_unit_scale: result.metadata.length_unit_scale,
        site_origin,
        ..CoordinateInfo::default()
    }
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;
