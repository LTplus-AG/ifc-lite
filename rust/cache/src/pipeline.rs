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

use std::collections::HashMap;

use ifc_lite_geometry::math::frame::{
    aabb_zup_to_yup, conjugate_zup_to_yup, zup_to_yup, zup_to_yup_in_place,
};
use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{
    process, MeshData, MeshFrame, ProcessingRequest, ProcessingResult, ProcessingSink,
};

use crate::geometry::coordinate_info::CoordinateInfo;
use crate::geometry::record::CacheMesh;

/// The meshes in emit order, already in the viewer frame, plus the frame
/// metadata.
pub(crate) struct Geometry {
    pub(crate) meshes: Vec<CacheMesh>,
    pub(crate) coordinate_info: CoordinateInfo,
    pub(crate) schema: &'static str,
}

/// Collects the per-batch finishes and the deferred colour corrections. The
/// meshes themselves are retained by the pass (`retain_meshes`), in emit order.
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

pub(crate) fn run(source: &[u8]) -> Geometry {
    // One chunk, every mesh retained in emit order. Material-layer slicing on,
    // as on the browser path the cache normally comes from; the first-frame
    // property and layer resolution off, since no record carries either.
    let features = ifc_lite_processing::Features::default()
        .properties(false)
        .presentation_layers(false)
        .finishes(true);
    let request = ProcessingRequest::full_pass()
        .layer_slicing(true)
        .retain_meshes(true)
        .features(features);
    let mut collector = Collector::default();
    let result = process(source, &request, &mut collector);
    let coordinate_info = coordinate_info(&result);
    let schema = ifc_lite_processing::detect_schema_version(source);
    let finishes = std::mem::take(&mut collector.finishes);
    let rotation = SiteRotation::removed_by(result.frame);
    let meshes = result
        .meshes
        .into_iter()
        .enumerate()
        .map(|(at, mesh)| {
            let finish = finishes.get(at).copied().flatten();
            let color = collector.colors.get(&mesh.express_id).copied();
            to_cache_mesh(mesh, finish, color, rotation)
        })
        .collect::<Vec<_>>();
    let coordinate_info = with_bounds(coordinate_info, &meshes);
    Geometry { meshes, coordinate_info, schema }
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
    mesh: MeshData,
    finish: Option<SpecularMaterial>,
    color: Option<[f32; 4]>,
    rotation: Option<SiteRotation>,
) -> CacheMesh {
    let MeshData { mut positions, mut normals, mut origin, .. } = mesh;
    if let Some(rotation) = rotation {
        rotation.restore_in_place(&mut positions);
        rotation.restore_in_place(&mut normals);
        origin = rotation.point(origin);
    }
    zup_to_yup_in_place(&mut positions);
    zup_to_yup_in_place(&mut normals);
    CacheMesh {
        express_id: mesh.express_id,
        ifc_type: mesh.ifc_type,
        positions,
        normals,
        indices: mesh.indices,
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

/// World bounds of the stored meshes (`origin + position`, viewer frame).
/// `originShift` is zero, so the original bounds equal the shifted ones, the
/// relation the TS `CoordinateHandler` keeps; an empty model is all zeros, as
/// `getFinalCoordinateInfo`'s fallback.
fn with_bounds(mut info: CoordinateInfo, meshes: &[CacheMesh]) -> CoordinateInfo {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for mesh in meshes {
        for vertex in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let value = mesh.origin[axis] + f64::from(vertex[axis]);
                if value.is_finite() {
                    min[axis] = min[axis].min(value);
                    max[axis] = max[axis].max(value);
                }
            }
        }
    }
    if min.iter().chain(&max).all(|v| v.is_finite()) {
        info.shifted_bounds = [min, max];
        info.original_bounds = [min, max];
    }
    info
}

#[cfg(test)]
#[path = "pipeline_tests.rs"]
mod tests;
