// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native Python bindings for ifc-lite geometry.
//!
//! Exposes the analysis geometry-data export (welded, IFC Z-up, absolute-world
//! metres, occurrence-keyed) directly to Python — no Node, no wasm, no
//! subprocess. This is the path compas_ifc and other Python consumers use.
//!
//! Two entry points share one pipeline:
//! - [`geometry_data_buffers`] (fast): vertices/faces as raw little-endian byte
//!   buffers for zero-parse `numpy.frombuffer` on the Python side.
//! - [`geometry_data_json`]: the human-readable `ifc-lite-geometry-data` JSON
//!   document (debugging / language-agnostic interchange).

use ifc_lite_processing::{build_geometry_data_export, process_geometry, GeometryDataExport};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict};

/// Stack size for the geometry worker (256 MiB). IFC CSG recurses deeply
/// (BSP-tree booleans, nested clips); the default thread stack overflows.
/// Mirrors `rust/ffi`.
const GEOMETRY_STACK_BYTES: usize = 256 * 1024 * 1024;

/// Run the native (rayon) pipeline off the calling thread with a large stack.
fn run_export(ifc_bytes: Vec<u8>) -> Result<GeometryDataExport, String> {
    std::thread::Builder::new()
        .stack_size(GEOMETRY_STACK_BYTES)
        .name("ifclite-geometry".into())
        .spawn(move || {
            let result = process_geometry(&ifc_bytes);
            let rtc = result.metadata.coordinate_info.origin_shift;
            // Reapply the IfcSite rotation only in the site-local axis frame;
            // model_rtc / raw_ifc keep true IFC world axes (R = identity).
            let site_rotation = if result.mesh_coordinate_space.as_deref() == Some("site_local") {
                result.site_transform.as_deref()
            } else {
                None
            };
            build_geometry_data_export(&result.meshes, rtc, site_rotation)
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
#[pyfunction]
#[pyo3(signature = (ifc_bytes))]
fn geometry_data_buffers(py: Python<'_>, ifc_bytes: Vec<u8>) -> PyResult<Py<PyAny>> {
    let export = py
        .detach(|| run_export(ifc_bytes))
        .map_err(PyRuntimeError::new_err)?;

    let out = PyDict::new(py);
    out.set_item("up_axis", export.up_axis)?;
    out.set_item("units", export.units)?;
    out.set_item("rtc_offset", export.rtc_offset.to_vec())?;
    out.set_item("element_count", export.element_count)?;

    let els = PyDict::new(py);
    for (id, el) in &export.elements {
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
    Ok(out.into_any().unbind())
}

/// Tessellate IFC bytes; return the `ifc-lite-geometry-data` JSON document as a
/// string. Same geometry as [`geometry_data_buffers`], but vertices/faces are
/// JSON arrays (no numpy needed) and each element also carries `global_id` and
/// `name` when present.
///
/// `ifc_bytes` is the raw IFC file content (e.g. `open(path, "rb").read()`).
#[pyfunction]
#[pyo3(signature = (ifc_bytes))]
fn geometry_data_json(py: Python<'_>, ifc_bytes: Vec<u8>) -> PyResult<String> {
    let export = py
        .detach(|| run_export(ifc_bytes))
        .map_err(PyRuntimeError::new_err)?;
    export
        .to_json()
        .map_err(|e| PyValueError::new_err(e.to_string()))
}

#[pymodule]
fn ifclite_geom(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(geometry_data_buffers, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_data_json, m)?)?;
    m.add("__doc__", "Native ifc-lite geometry-data export for Python.")?;
    Ok(())
}
