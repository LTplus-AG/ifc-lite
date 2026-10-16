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
//! A third entry point, [`entity_data::entity_data`], reads the non-geometric half of the
//! file (attributes, property sets, quantity sets) over `ifc-lite-export`'s
//! attribute model, the same one behind the wasm `exportCsv` / `exportJson`.

use ifc_lite_processing::{
    build_colored_geometry_data_export, extract_swept_disk_descriptions,
    process_geometry_filtered_with_quality_and_ids, ColoredGeometryDataExport,
    OpeningFilterMode, SweptDiskDescriptions, TessellationQuality, run_on_geometry_pool,
};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};
use std::collections::HashSet;

mod swept_disks;
mod alignment_axes;
mod analytic_definitions;
mod quantity_analysis;
mod rebar_schedule;
mod entity_data;
mod swept_disk_checks;

struct GeometryExportResult {
    meshes: ColoredGeometryDataExport,
    swept_disks: Option<SweptDiskDescriptions>,
}

/// Run `work` with the GIL released on processing's large-stack geometry pool
/// (EDGE-FFI-1 / EDGE-FFI-3, #7673). The deep recursion in IFC geometry
/// runs in `par_iter` jobs, so it is the pool WORKERS that need the large
/// stack: a big-stack thread calling the pipeline, which every entry point here
/// used to spawn, left those jobs on rayon's default-stack global pool, where
/// an overflow aborts the Python interpreter. `what` names the work in errors.
///
/// A panic in `work` becomes a `RuntimeError` carrying the panic message.
fn run_geometry<T: Send>(
    py: Python<'_>,
    what: &str,
    work: impl FnOnce() -> T + Send,
) -> PyResult<T> {
    py.detach(|| {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_on_geometry_pool(work)))
            .map_err(|payload| format!("{what} worker panicked: {}", panic_message(payload.as_ref())))?
            .map_err(|error| format!("{what}: cannot start the geometry thread pool: {error}"))
    })
    .map_err(PyRuntimeError::new_err)
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload")
}

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

/// Run the native (rayon) pipeline on the large-stack geometry pool.
fn run_export(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    quality: TessellationQuality,
    ids: Option<HashSet<u32>>,
    include_directrices: bool,
) -> PyResult<GeometryExportResult> {
    run_geometry(py, "geometry", move || {
        let result = process_geometry_filtered_with_quality_and_ids(
            &ifc_bytes,
            OpeningFilterMode::Default,
            quality,
            ids.as_ref(),
        );
        let (rx, ry, rz) = result.frame.rtc_offset();
        let rtc = [rx, ry, rz];
        // The frame says which rotation the bake removed (the site tier only),
        // so this does not re-derive the tier rule (#7684).
        let site_rotation = result.frame.site_placement();
        let meshes = build_colored_geometry_data_export(&result.meshes, rtc, site_rotation.as_ref().map(|m| &m[..]));
        let swept_disks = include_directrices
            .then(|| extract_swept_disk_descriptions(&ifc_bytes, ids.as_ref()));
        GeometryExportResult { meshes, swept_disks }
    })
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
    let export = run_export(py, ifc_bytes, quality, ids, include_directrices)?;

    let out = PyDict::new(py);
    out.set_item("up_axis", export.meshes.up_axis)?;
    out.set_item("units", export.meshes.units)?;
    out.set_item("rtc_offset", export.meshes.rtc_offset.to_vec())?;
    out.set_item("element_count", export.meshes.element_count)?;

    let els = PyDict::new(py);
    for (id, colored) in &export.meshes.elements {
        let el = &colored.geometry;
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
        if !colored.palette.is_empty() {
            d.set_item("palette", colored.palette.iter().map(|c| c.to_vec()).collect::<Vec<_>>())?;
            let colors: Vec<u8> = colored.face_colors.iter().flat_map(|index| index.to_le_bytes()).collect();
            d.set_item("face_colors", PyBytes::new(py, &colors))?;
        }
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
    let export = run_export(py, ifc_bytes, quality, ids, include_directrices)?;
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
    m.add_function(wrap_pyfunction!(alignment_axes::alignment_axes, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_data_buffers, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_data_json, m)?)?;
    m.add_function(wrap_pyfunction!(analytic_definitions::swept_disk_definitions, m)?)?;
    m.add_function(wrap_pyfunction!(analytic_definitions::extrusion_definitions, m)?)?;
    m.add_function(wrap_pyfunction!(quantity_analysis::authored_quantity_analysis, m)?)?;
    m.add_function(wrap_pyfunction!(quantity_analysis::quantity_analysis, m)?)?;
    m.add_function(wrap_pyfunction!(rebar_schedule::rebar_schedule, m)?)?;
    m.add_function(wrap_pyfunction!(rebar_schedule::rebar_schedule_with_preflight, m)?)?;
    m.add_function(wrap_pyfunction!(rebar_schedule::rebar_schedule_with_fabrication_precheck, m)?)?;
    m.add_function(wrap_pyfunction!(entity_data::entity_data, m)?)?;
    m.add_function(wrap_pyfunction!(swept_disk_checks::check_swept_disks, m)?)?;
    m.add("__doc__", "Native ifc-lite geometry and attribute export for Python.")?;
    Ok(())
}
