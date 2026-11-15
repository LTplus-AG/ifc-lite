// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The geometry pass: the canonical native `process`, and the conversion of
//! its meshes and frame into what the cache stores.
//!
//! Nothing here meshes anything: every vertex comes from
//! `ifc_lite_processing::process`, unchanged except for the one IFC Z-up to
//! viewer Y-up swap the browser path applies (`MeshDataJs::new` in
//! `rust/wasm-bindings`), through the same `ifc_lite_geometry::math::frame`
//! functions.

use std::collections::HashMap;

use ifc_lite_geometry::math::frame::{
    aabb_zup_to_yup, conjugate_zup_to_yup, zup_to_yup, zup_to_yup_in_place,
};
use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult, ProcessingSink};

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
    let meshes = result
        .meshes
        .into_iter()
        .enumerate()
        .map(|(at, mesh)| {
            let finish = finishes.get(at).copied().flatten();
            let color = collector.colors.get(&mesh.express_id).copied();
            to_cache_mesh(mesh, finish, color)
        })
        .collect::<Vec<_>>();
    let coordinate_info = with_bounds(coordinate_info, &meshes);
    Geometry { meshes, coordinate_info, schema }
}

fn to_cache_mesh(mesh: MeshData, finish: Option<SpecularMaterial>, color: Option<[f32; 4]>) -> CacheMesh {
    let MeshData { mut positions, mut normals, .. } = mesh;
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
        origin: stored_origin(zup_to_yup(mesh.origin)),
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
