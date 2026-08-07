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

use ifc_lite_export::{build_export_model_with_options, ExportModel, ModelOptions};
use ifc_lite_processing::{
    build_geometry_data_export, process_geometry_filtered_with_quality, GeometryDataExport,
    OpeningFilterMode, TessellationQuality,
};
use pyo3::exceptions::{PyRuntimeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyDict, PyList};

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
) -> Result<GeometryDataExport, String> {
    std::thread::Builder::new()
        .stack_size(GEOMETRY_STACK_BYTES)
        .name("ifclite-geometry".into())
        .spawn(move || {
            let result = process_geometry_filtered_with_quality(
                &ifc_bytes,
                OpeningFilterMode::Default,
                quality,
            );
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
/// `quality` selects the tessellation detail level (`"lowest"`, `"low"`,
/// `"medium"` (default), `"high"`, `"highest"`), scaling the segment count on
/// every curved primitive (swept-disk tubes, cylinders, revolutions, arcs).
#[pyfunction]
#[pyo3(signature = (ifc_bytes, quality = None))]
fn geometry_data_buffers(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    quality: Option<&str>,
) -> PyResult<Py<PyAny>> {
    let quality = parse_quality(quality)?;
    let export = py
        .detach(|| run_export(ifc_bytes, quality))
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
/// `quality` is as documented on [`geometry_data_buffers`].
#[pyfunction]
#[pyo3(signature = (ifc_bytes, quality = None))]
fn geometry_data_json(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    quality: Option<&str>,
) -> PyResult<String> {
    let quality = parse_quality(quality)?;
    let export = py
        .detach(|| run_export(ifc_bytes, quality))
        .map_err(PyRuntimeError::new_err)?;
    export
        .to_json()
        .map_err(|e| PyValueError::new_err(e.to_string()))
}

/// Run the attribute/property extraction off the calling thread.
///
/// Shares the geometry worker's large stack: the placement resolver walks an
/// `IfcLocalPlacement` chain recursively, and the decode path is the same one
/// the geometry pipeline needs the headroom for.
fn run_entity_export(
    ifc_bytes: Vec<u8>,
    placements: bool,
    type_properties: bool,
    attributes: bool,
) -> Result<ExportModel, String> {
    let opts = ModelOptions::default()
        .with_placements(placements)
        .with_inherit_type_properties(type_properties)
        .with_attributes(attributes);
    std::thread::Builder::new()
        .stack_size(GEOMETRY_STACK_BYTES)
        .name("ifclite-entities".into())
        .spawn(move || build_export_model_with_options(&ifc_bytes, &opts))
        .map_err(|e| format!("spawn failed: {e}"))?
        .join()
        .map_err(|_| "entity worker panicked".to_string())
}

/// Read attributes, property sets and quantity sets. No tessellation.
///
/// Returns a dict:
/// `{ length_unit_scale, plane_angle_to_radians, project_id, entity_count,
///    entities: { express_id: { ifc_type, global_id, name, description,
///    object_type, has_geometry, placement, property_sets, quantity_sets } } }`
///
/// `entities` is keyed by IFC STEP id in file order, so it joins directly
/// against `geometry_data_buffers()["elements"]`. The join is one-way total:
/// every meshed element has a row here, but not every row has an element.
/// Besides products with no geometry, an orphan `IfcTypeProduct` gets a row
/// with `has_geometry = True` and yet never appears in `elements`, because the
/// geometry functions emit occurrences only. Drive the join from `elements`,
/// or use `.get()`.
///
/// **Property values are strings, in the file's OWN units.** A millimetre model
/// reports `Qto_WallBaseQuantities.Length` as `3000`, while geometry from this
/// module is always metres. Quantity values are floats and carry the same
/// caveat.
///
/// Converting is per dimension, not one blanket factor: multiply a `Length` by
/// `length_unit_scale`, an `Area` by its SQUARE and a `Volume` by its CUBE, and
/// use `plane_angle_to_radians` for angles. `Count` is dimensionless. Only the
/// length and plane-angle scales are resolved, so a model declaring an area or
/// volume unit inconsistent with its length unit cannot be reconciled from what
/// is returned here.
///
/// `placement` is `None` unless `placements=True`, and is then a list of 16
/// floats: a COLUMN-major 4x4, translation in metres at indices 12/13/14.
///
/// It is in the same absolute IFC world frame as `geometry_data_buffers`
/// vertices, so the two line up directly: do NOT fold `rtc_offset` into either.
/// The geometry export already adds the offset back into every vertex, and this
/// placement is never RTC-rebased, so both are unshifted, Z-up and in metres.
///
/// **Type-inherited properties are included by default** (`type_properties`).
/// A type attaches its sets via `IfcTypeObject.HasPropertySets`, and a plain
/// `IfcWallType` holding `Pset_WallCommon` gets no row of its own here, so
/// before this the properties authoring tools put on types were unreachable.
/// Each occurrence now also carries what it inherits through
/// `IfcRelDefinesByType`, merged per property:
///
/// * A type set whose name the occurrence does not use is added whole.
/// * A type set sharing a name contributes only the properties the occurrence
///   does not already define, so on a collision the occurrence wins and the
///   type-only properties beside it still survive.
///
/// Pass `type_properties=False` for own-sets-only, which is what this function
/// returned in 4.3.0.
///
/// Remaining limit, inherited from the shared export model: only
/// `IfcPropertySingleValue` properties are decoded. Enumerated, list, bounded,
/// table and reference properties are skipped silently, and the pset still
/// appears with those entries missing.
///
/// **Schema-declared entity attributes** arrive in their own `attributes` list,
/// on by default. These are unrelated to the `IfcTypeObject` inheritance above,
/// despite IFC prose calling both "type": they are declared on the entity's own
/// class, are not property sets, and no amount of pset work surfaces them.
///
/// An `IfcReinforcingBar` can carry `SteelGrade`, `NominalDiameter`,
/// `CrossSectionArea`, `BarLength`, `PredefinedType`, `BarSurface` and `Tag`;
/// an `IfcDoor` can carry `OverallHeight` / `OverallWidth`, and so on for every
/// class, named as the schema names them and in its order. Only what the file
/// sets is returned: an attribute left `$` is omitted rather than reported
/// empty, so the list is usually shorter than the class declares.
///
/// Each entry has the same `{name, value, value_type}` shape as a property, so
/// one code path reads both. The fields this dict already carries (`global_id`,
/// `name`, `description`, `object_type`) are not repeated, and
/// reference-valued attributes are omitted rather than rendered as a dangling
/// id. Pass `attributes=False` to skip them.
#[pyfunction]
#[pyo3(signature = (ifc_bytes, placements = false, type_properties = true, attributes = true))]
fn entity_data(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    placements: bool,
    type_properties: bool,
    attributes: bool,
) -> PyResult<Py<PyAny>> {
    let model = py
        .detach(|| run_entity_export(ifc_bytes, placements, type_properties, attributes))
        .map_err(PyRuntimeError::new_err)?;

    let out = PyDict::new(py);
    out.set_item("length_unit_scale", model.units.length_unit_scale)?;
    out.set_item("plane_angle_to_radians", model.units.plane_angle_to_radians)?;
    out.set_item("project_id", model.units.project_id)?;

    let entities = PyDict::new(py);
    for row in &model.entities {
        let d = PyDict::new(py);
        d.set_item("ifc_type", &row.ifc_type)?;
        d.set_item("global_id", row.global_id.clone())?;
        d.set_item("name", row.name.clone())?;
        d.set_item("description", row.description.clone())?;
        d.set_item("object_type", row.object_type.clone())?;
        d.set_item("has_geometry", row.has_geometry)?;
        d.set_item("placement", row.placement.map(|p| p.matrix.to_vec()))?;

        let psets = PyList::empty(py);
        for ps in &row.property_sets {
            let props = PyList::empty(py);
            for p in &ps.properties {
                let pd = PyDict::new(py);
                pd.set_item("name", &p.name)?;
                pd.set_item("value", &p.value)?;
                pd.set_item("value_type", &p.value_type)?;
                props.append(pd)?;
            }
            let sd = PyDict::new(py);
            sd.set_item("name", &ps.name)?;
            sd.set_item("properties", props)?;
            psets.append(sd)?;
        }
        d.set_item("property_sets", psets)?;

        let qsets = PyList::empty(py);
        for qs in &row.quantity_sets {
            let quants = PyList::empty(py);
            for q in &qs.quantities {
                let qd = PyDict::new(py);
                qd.set_item("name", &q.name)?;
                qd.set_item("value", q.value)?;
                qd.set_item("kind", q.kind)?;
                quants.append(qd)?;
            }
            let sd = PyDict::new(py);
            sd.set_item("name", &qs.name)?;
            sd.set_item("quantities", quants)?;
            qsets.append(sd)?;
        }
        d.set_item("quantity_sets", qsets)?;

        // Same {name, value, value_type} shape as a property, so a consumer can
        // read an attribute and a property with one code path.
        let attrs = PyList::empty(py);
        for a in &row.attributes {
            let ad = PyDict::new(py);
            ad.set_item("name", &a.name)?;
            ad.set_item("value", &a.value)?;
            ad.set_item("value_type", &a.value_type)?;
            attrs.append(ad)?;
        }
        d.set_item("attributes", attrs)?;

        entities.set_item(row.express_id, d)?;
    }
    // Count the DICT, not the row list. A malformed file can repeat a STEP id,
    // and keying by `express_id` collapses those to one entry (last wins), so
    // `model.entities.len()` would promise more entries than are readable.
    out.set_item("entity_count", entities.len())?;
    out.set_item("entities", entities)?;
    Ok(out.into_any().unbind())
}

#[pymodule]
fn ifclite_geom(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(geometry_data_buffers, m)?)?;
    m.add_function(wrap_pyfunction!(geometry_data_json, m)?)?;
    m.add_function(wrap_pyfunction!(entity_data, m)?)?;
    m.add(
        "__doc__",
        "Native ifc-lite geometry and attribute export for Python.",
    )?;
    Ok(())
}
