// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Non-geometric IFC attribute, property, and quantity export for Python.

use ifc_lite_export::{build_export_model_with_options, ExportModel, ModelOptions};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use super::GEOMETRY_STACK_BYTES;

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
/// `quantity_sets` inherit on exactly the same terms. A type attaches
/// `IfcElementQuantity` definitions through the same `HasPropertySets`
/// attribute, so they arrive by the same route and merge by the same rule: a
/// type quantity set the occurrence does not name is added whole, and a
/// same-named one contributes only the quantities the occurrence does not
/// already define, so the occurrence wins a collision. One flag governs both
/// lists.
///
/// Pass `type_properties=False` for own-sets-only, which is what this function
/// returned in 4.3.0, and which affects `property_sets` and `quantity_sets`
/// alike.
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
pub(super) fn entity_data(
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
