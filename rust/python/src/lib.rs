//! Native Python bindings for ifc-lite geometry.
//!
//! Exposes the analysis geometry-data export (welded, IFC Z-up, absolute-world
//! metres, occurrence-keyed) directly to Python — no Node, no wasm, no
//! subprocess. This is the path compas_ifc and other Python consumers use.

use ifc_lite_processing::{build_geometry_data_export, process_geometry};
use pyo3::prelude::*;

/// Stack size for the geometry worker (256 MiB). IFC CSG recurses deeply
/// (BSP-tree booleans, nested clips); the default thread stack overflows.
/// Mirrors `rust/ffi`.
const GEOMETRY_STACK_BYTES: usize = 256 * 1024 * 1024;

/// Tessellate IFC bytes and return the `ifc-lite-geometry-data` JSON document:
/// `{ schema, version, up_axis:"Z", units:"m", rtc_offset, elements: { "<stepId>":
/// { ifc_type, vertices:[[x,y,z]], faces:[[i,i,i]], color } } }`.
///
/// Vertices are welded, IFC Z-up, absolute-world metres.
#[pyfunction]
fn geometry_data_json(py: Python<'_>, ifc_bytes: Vec<u8>) -> PyResult<String> {
    // Run the (rayon) pipeline off the Python thread with a large stack, and
    // release the GIL while it works.
    py.allow_threads(move || {
        std::thread::Builder::new()
            .stack_size(GEOMETRY_STACK_BYTES)
            .name("ifclite-geometry".into())
            .spawn(move || {
                let result = process_geometry(&ifc_bytes);
                let rtc = result.metadata.coordinate_info.origin_shift;
                build_geometry_data_export(&result.meshes, rtc).to_json()
            })
            .map_err(|e| {
                pyo3::exceptions::PyRuntimeError::new_err(format!("spawn failed: {e}"))
            })?
            .join()
            .map_err(|_| {
                pyo3::exceptions::PyRuntimeError::new_err("geometry worker panicked")
            })?
            .map_err(|e| pyo3::exceptions::PyValueError::new_err(e.to_string()))
    })
}

#[pymodule]
fn ifclite_geom(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(geometry_data_json, m)?)?;
    m.add("__doc__", "Native ifc-lite geometry-data export for Python.")?;
    Ok(())
}
