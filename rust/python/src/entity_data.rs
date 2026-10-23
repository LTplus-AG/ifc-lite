// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Non-geometric IFC attribute, property, and quantity export for Python.

use std::sync::Arc;

use ifc_lite_export::{stream_export_model_with_inherited, ExportModel, Inherited, ModelOptions, PropValue};
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use super::run_geometry;

/// Run the attribute/property extraction on the large-stack geometry pool.
///
/// Shares the geometry workers' large stack: the placement resolver walks an
/// `IfcLocalPlacement` chain recursively, and the decode path is the same one
/// the geometry pipeline needs the headroom for.
fn run_entity_export(
    py: Python<'_>,
    ifc_bytes: Vec<u8>,
    placements: bool,
    type_properties: bool,
    attributes: bool,
) -> PyResult<(ExportModel, Vec<Inherited>)> {
    let opts = ModelOptions::default()
        .with_placements(placements)
        .with_inherit_type_properties(type_properties)
        .with_attributes(attributes);
    run_geometry(py, "entity", move || {
        let index = Arc::new(ifc_lite_processing::build_entity_index_parallel(&ifc_bytes));
        let (mut entities, mut inherited) = (Vec::new(), Vec::new());
        let units = stream_export_model_with_inherited(&ifc_bytes, &index, &opts, |row, flags, _| {
            entities.push(row);
            inherited.push(flags);
        });
        (ExportModel { entities, units }, inherited)
    })
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
/// A type attaches its sets via `IfcTypeObject.HasPropertySets` (or an
/// `IfcRelDefinesByProperties` naming the type, also read), and a plain
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
/// Every property and quantity dict carries `inherited`: `True` when it came
/// from the type, including the copy added to each same-named set the
/// occurrence carries, and always `False` with `type_properties=False`.
///
/// Pass `type_properties=False` for own-sets-only, which is what this function
/// returned in 4.3.0, and which affects `property_sets` and `quantity_sets`
/// alike.
///
/// Each property dictionary contains `name`, `value`, `value_type` and
/// `inherited`.
/// Every property kind is decoded (EXPORT-DATA-2, D47). An
/// `IfcPropertySingleValue` returns its nominal value as a string; an
/// enumerated, list, bounded, table, reference or complex property returns its
/// display string (`"A, B"`, `"2 [1 – 5]"`, `"Table (2 rows)"`,
/// `"Inner: a, Other: 2.5"`). A reference uses the target's nonblank `Name`,
/// else its nonblank `Identification`, else `#<id>`. For
/// `IfcPropertySingleValue`, `value_type` is the nominal value's rendered type
/// tag (for example, `IFCLABEL` or `IFCREAL`). For other property kinds, it is
/// the members' shared type tag, else the property class keyword
/// (`IFCPROPERTYTABLEVALUE`, ...).
/// Complex properties share the model's complex-property budget (#7675).
/// Quantity dictionaries contain `name`, a numeric `value` and `kind`.
///
/// For `ifc_bytes` containing property and quantity sets, including a
/// `Text` single-value property with an `IFCLABEL` nominal value:
///
/// >>> import ifclite_geom
/// >>> rows = ifclite_geom.entity_data(ifc_bytes)["entities"].values()
/// >>> prop = next(p for row in rows for ps in row["property_sets"] for p in ps["properties"])
/// >>> sorted(prop)
/// ['inherited', 'name', 'value', 'value_type']
/// >>> isinstance(prop["value"], str)
/// True
/// >>> "kind" in prop
/// False
/// >>> text = next(p for row in rows for ps in row["property_sets"] for p in ps["properties"] if p["name"] == "Text")
/// >>> text["value_type"]
/// 'IFCLABEL'
/// >>> quantity = next(q for row in rows for qs in row["quantity_sets"] for q in qs["quantities"])
/// >>> sorted(quantity)
/// ['inherited', 'kind', 'name', 'value']
/// >>> isinstance(quantity["value"], float)
/// True
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
/// Each entry has the same `{name, value, value_type, inherited}` shape as a
/// property, `inherited` always `False`, so one code path reads both. The fields this dict already carries (`global_id`,
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
    let (model, inherited) = run_entity_export(py, ifc_bytes, placements, type_properties, attributes)?;

    let out = PyDict::new(py);
    out.set_item("length_unit_scale", model.units.length_unit_scale)?;
    out.set_item("plane_angle_to_radians", model.units.plane_angle_to_radians)?;
    out.set_item("project_id", model.units.project_id)?;

    let entities = PyDict::new(py);
    for (row, inherited) in model.entities.iter().zip(&inherited) {
        let d = PyDict::new(py);
        d.set_item("ifc_type", &row.ifc_type)?;
        d.set_item("global_id", row.global_id.clone())?;
        d.set_item("name", row.name.clone())?;
        d.set_item("description", row.description.clone())?;
        d.set_item("object_type", row.object_type.clone())?;
        d.set_item("has_geometry", row.has_geometry)?;
        d.set_item("placement", row.placement.map(|p| p.matrix.to_vec()))?;

        let psets = PyList::empty(py);
        for (i, ps) in row.property_sets.iter().enumerate() {
            let props = PyList::empty(py);
            for (j, p) in ps.properties.iter().enumerate() {
                props.append(prop_dict(py, p, inherited.property(i, j))?)?;
            }
            let sd = PyDict::new(py);
            sd.set_item("name", &ps.name)?;
            sd.set_item("properties", props)?;
            psets.append(sd)?;
        }
        d.set_item("property_sets", psets)?;

        let qsets = PyList::empty(py);
        for (i, qs) in row.quantity_sets.iter().enumerate() {
            let quants = PyList::empty(py);
            for (j, q) in qs.quantities.iter().enumerate() {
                let qd = PyDict::new(py);
                qd.set_item("name", &q.name)?;
                qd.set_item("value", q.value)?;
                qd.set_item("kind", q.kind)?;
                qd.set_item("inherited", inherited.quantity(i, j))?;
                quants.append(qd)?;
            }
            let sd = PyDict::new(py);
            sd.set_item("name", &qs.name)?;
            sd.set_item("quantities", quants)?;
            qsets.append(sd)?;
        }
        d.set_item("quantity_sets", qsets)?;

        // Same shape as a property dict, so one code path reads both.
        let attrs = PyList::empty(py);
        for a in &row.attributes {
            attrs.append(prop_dict(py, a, false)?)?;
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

/// A property or attribute as a `{name, value, value_type, inherited}` dict.
fn prop_dict<'py>(py: Python<'py>, p: &PropValue, inherited: bool) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("name", &p.name)?;
    d.set_item("value", &p.value)?;
    d.set_item("value_type", &p.value_type)?;
    d.set_item("inherited", inherited)?;
    Ok(d)
}
