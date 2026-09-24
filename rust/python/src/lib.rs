// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native Python bindings for ifc-lite geometry.
//!
//! Exposes the analysis geometry-data export (welded, IFC Z-up, absolute-world
//! metres, occurrence-keyed) directly to Python — no Node, no wasm, no
//! subprocess. This is the path compas_ifc and other Python consumers use.
//!
//! Two entry points share one geometry pipeline:
//! - [`geometry_data_buffers`] (fast): vertices/faces as raw little-endian byte
//!   buffers for zero-parse `numpy.frombuffer` on the Python side.
//! - [`geometry_data_json`]: the human-readable `ifc-lite-geometry-data` JSON
//!   document (debugging / language-agnostic interchange).
//!
//! Both accept a `quality` label selecting the tessellation detail level, the
//! same knob the wasm path exposes as `setTessellationQuality` and the server as
//! `?tessellation_quality=`.
//!
//! A third entry point, [`entity_data`], reads the non-geometric half of the
//! file (attributes, property sets, quantity sets) over `ifc-lite-export`'s
//! attribute model, the same one behind the wasm `exportCsv` / `exportJson`.

use ifc_lite_processing::{
    build_geometry_data_export, extract_swept_disk_descriptions,
    process_geometry_filtered_with_quality_and_ids, GeometryDataExport, MeshCoordinateSpace,
    OpeningFilterMode, SweptDiskDescriptions, TessellationQuality,
};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};
use std::collections::HashSet;

mod swept_disks;
mod swept_disk_checks;
mod analytic_definitions;
mod entity_data;

struct GeometryExportResult {
    meshes: GeometryDataExport,
    swept_disks: Option<SweptDiskDescriptions>,
}

/// Stack size for the geometry worker (256 MiB). IFC CSG recurses deeply
/// (BSP-tree booleans, nested clips); the default thread stack overflows.
/// Mirrors `rust/ffi`.
const GEOMETRY_STACK_BYTES: usize = 256 * 1024 * 1024;

/// Map a consumer-facing quality label onto [`TessellationQuality`].
///
/// `None` keeps the engine default (`medium`), which is byte-for-byte the
/// output this module produced before the knob existed. An unknown label is a
/// hard error rather than a silent fallback: each level is a factor of two in
/// density, so a caller that asked for `"lowest"` and quietly got `medium`
/// would pay several times the triangle budget it asked for, with no signal.
fn parse_quality(label: Option<&str>) -> PyResult<TessellationQuality> {
    match label {
        None => Ok(TessellationQuality::default()),
        Some(s) => TessellationQuality::parse_label(s).ok_or_else(|| {
            PyValueError::new_err(format!(
                "unknown tessellation quality {s:?}; expected one of \
                 'lowest', 'low', 'medium', 'high', 'highest'"
            ))
        }),
    }
}

/// Run the native (rayon) pipeline off the calling thread with a large stack.
fn run_export(
    ifc_bytes: Vec<u8>,
    quality: TessellationQuality,
    ids: Option<HashSet<u32>>,
    include_directrices: bool,
) -> Result<GeometryExportResult, String> {
    std::thread::Builder::new()
        .stack_size(GEOMETRY_STACK_BYTES)
        .name("ifclite-geometry".into())
        .spawn(move || {
            let result = process_geometry_filtered_with_quality_and_ids(
                &ifc_bytes,
                OpeningFilterMode::Default,
                quality,
                ids.as_ref(),
            );
            let rtc = result.metadata.coordinate_info.origin_shift;
            // Reapply the IfcSite rotation only in the site-local axis frame;
            // model_rtc / raw_ifc keep true IFC world axes (R = identity).
            let site_rotation = if result.mesh_coordinate_space == MeshCoordinateSpace::SiteLocal {
                result.site_transform.as_deref()
            } else {
                None
            };
            let meshes = build_geometry_data_export(&result.meshes, rtc, site_rotation);
            let swept_disks = include_directrices
                .then(|| extract_swept_disk_descriptions(&ifc_bytes, ids.as_ref()));
            GeometryExportResult { meshes, swept_disks }
        })
        .map_err(|e| format!("spawn failed: {e}"))?
        .join()
        .map_err(|_| "geometry worker panicked".to_string())
}

/// Tessellate IFC bytes; return per-entity geometry with vertices/faces as raw
/// little-endian byte buffers (f64 xyz triplets, u32 triangle indices) for
/// `numpy.frombuffer`. Returns a dict:
/// `{ up_axis:"Z", units:"m", rtc_offset:[x,y,z], element_count,
///    elements: { step_id: { ifc_type, global_id, name, color:[r,g,b,a],
///    vertices:bytes, faces:bytes } } }`. `global_id` / `name` are `None` when
///    the source entity has none. Vertices are welded, IFC Z-up, absolute-world
///    metres, keyed by IFC STEP id (occurrences only).
///
/// `ifc_bytes` is the raw IFC file content (e.g. `open(path, "rb").read()`).
/// `quality` selects the tessellation detail level (`"lowest"`, `"low"`,
/// `"medium"` (default), `"high"`, `"highest"`), scaling the segment count on
/// every curved primitive (swept-disk tubes, cylinders, revolutions, arcs).
/// `ids` optionally restricts tessellation to those IFC STEP ids. `None` keeps
/// every occurrence, while an empty set produces an empty geometry export.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, quality = None, ids = None, *, include_directrices = false))]
fn geometry_data_buffers(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    quality: Option<&str>,
    ids: Option<HashSet<u32>>,
    include_directrices: bool,
) -> PyResult<Py<PyAny>> {
    let quality = parse_quality(quality)?;
    let export = py
        .detach(|| run_export(ifc_bytes, quality, ids, include_directrices))
        .map_err(PyRuntimeError::new_err)?;

    let out = PyDict::new(py);
    out.set_item("up_axis", export.meshes.up_axis)?;
    out.set_item("units", export.meshes.units)?;
    out.set_item("rtc_offset", export.meshes.rtc_offset.to_vec())?;
    out.set_item("element_count", export.meshes.element_count)?;

    let els = PyDict::new(py);
    for (id, el) in &export.meshes.elements {
        let d = PyDict::new(py);
        d.set_item("ifc_type", &el.ifc_type)?;
        // Mirror the JSON path so both exports carry the same identity fields;
        // `None` maps to Python `None` (key always present).
        d.set_item("global_id", el.global_id.clone())?;
        d.set_item("name", el.name.clone())?;
        d.set_item("color", el.color.to_vec())?;
        // Reinterpret the contiguous `[f64;3]` / `[u32;3]` vecs as little-endian
        // bytes (zero-copy; PyBytes copies into Python). Targets are all LE.
        let vbytes: &[u8] = unsafe {
            std::slice::from_raw_parts(
                el.vertices.as_ptr() as *const u8,
                std::mem::size_of_val(el.vertices.as_slice()),
            )
        };
        let fbytes: &[u8] = unsafe {
            std::slice::from_raw_parts(
                el.faces.as_ptr() as *const u8,
                std::mem::size_of_val(el.faces.as_slice()),
            )
        };
        d.set_item("vertices", PyBytes::new(py, vbytes))?;
        d.set_item("faces", PyBytes::new(py, fbytes))?;
        els.set_item(*id, d)?;
    }
    out.set_item("elements", els)?;
    if let Some(descriptions) = &export.swept_disks {
        swept_disks::add_to_python(py, &out, descriptions)?;
    }
    Ok(out.into_any().unbind())
}

/// Tessellate IFC bytes; return the `ifc-lite-geometry-data` JSON document as a
/// string. Same geometry as [`geometry_data_buffers`], but vertices/faces are
/// JSON arrays (no numpy needed) and each element also carries `global_id` and
/// `name` when present.
///
/// `ifc_bytes` is the raw IFC file content (e.g. `open(path, "rb").read()`).
/// `quality` and `ids` are as documented on [`geometry_data_buffers`].
#[pyfunction]
#[pyo3(signature = (ifc_bytes, quality = None, ids = None, *, include_directrices = false))]
fn geometry_data_json(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    quality: Option<&str>,
    ids: Option<HashSet<u32>>,
    include_directrices: bool,
) -> PyResult<String> {
    let quality = parse_quality(quality)?;
    let export = py
        .detach(|| run_export(ifc_bytes, quality, ids, include_directrices))
        .map_err(PyRuntimeError::new_err)?;
    let json = export.meshes
        .to_json()
        .map_err(|e| PyValueError::new_err(e.to_string()))?;
    match &export.swept_disks {
        Some(descriptions) => swept_disks::add_to_json(json, descriptions)
            .map_err(|e| PyValueError::new_err(e.to_string())),
        None => Ok(json),
    }
}

#[pymodule]
fn ifclite_geom(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(geometry_data_buffers, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_data_json, m)?)?;
    m.add_function(wrap_pyfunction!(swept_disk_checks::check_swept_disks, m)?)?;
    m.add_function(wrap_pyfunction!(analytic_definitions::swept_disk_definitions, m)?)?;
    m.add_function(wrap_pyfunction!(entity_data::entity_data, m)?)?;
    m.add("__doc__", "Native ifc-lite geometry and attribute export for Python.")?;
    Ok(())
}
