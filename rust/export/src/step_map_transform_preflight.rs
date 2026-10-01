// SPDX-License-Identifier: MPL-2.0
//! Fail-closed semantic checks for map normalization; placement math remains
//! in GeometryRouter. These walks only validate file-controlled references.

use std::collections::{HashMap, HashSet};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType, MAX_PLACEMENT_DEPTH};
use nalgebra::{Matrix4, Vector3};
use super::Record;

pub(super) fn operation(map: &DecodedEntity) -> Result<(), String> {
    for slot in 2..=7 {
        if slot >= 5 && map.get(slot).is_some_and(|attr| attr.is_null()) { continue; }
        let value = map.get_float(slot).filter(|value| value.is_finite())
            .ok_or_else(|| format!("map conversion #{} has invalid numeric slot {slot}", map.id))?;
        if slot == 7 && value <= 0.0 { return Err("map Scale must be positive".into()); }
    }
    let x = map.get_float(5).unwrap_or(1.0);
    let y = map.get_float(6).unwrap_or(0.0);
    if !x.hypot(y).is_finite() || x.hypot(y) == 0.0 { return Err("map rotation direction is zero or unbounded".into()); }
    if map.ifc_type == IfcType::IfcMapConversionScaled {
        for slot in 8..=10 {
            if !map.get_float(slot).is_some_and(|value| value.is_finite() && value > 0.0) {
                return Err("map per-axis factors must be positive and finite".into());
            }
        }
    }
    Ok(())
}

pub(super) fn map_unit(target: &DecodedEntity, project_metres: f64, decoder: &mut EntityDecoder) -> Result<(), String> {
    let attr = target.get(6).ok_or("ProjectedCRS is missing its MapUnit slot")?;
    if attr.is_null() {
        // IFC's omitted MapUnit inherits the *validated* project length unit.
        return if project_metres == 1.0 { Ok(()) } else {
            Err("normalize map units to metres before normalizing map geometry".into())
        };
    }
    let unit = required(target, 6, decoder)?;
    if unit.ifc_type != IfcType::IfcSIUnit
        || unit.get(1).and_then(AttributeValue::as_enum) != Some("LENGTHUNIT")
        || !unit.get(2).is_some_and(AttributeValue::is_null)
        || unit.get(3).and_then(AttributeValue::as_enum) != Some("METRE") {
        return Err(format!("ProjectedCRS #{} MapUnit #{} is not an explicit SI metre length unit; normalize units first", target.id, unit.id));
    }
    Ok(())
}

pub(super) fn project_units(project: u32, decoder: &mut EntityDecoder) -> Result<(), String> {
    let project = decoder.decode_by_id(project).map_err(|error| error.to_string())?;
    let assignment = required(&project, 8, decoder)?;
    if assignment.ifc_type != IfcType::IfcUnitAssignment { return Err("invalid project unit assignment".into()); }
    let mut length_units = Vec::new();
    for id in assignment.get_refs(0).ok_or("project Units list is invalid")? {
        let unit = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
        if unit.get(1).and_then(AttributeValue::as_enum) == Some("LENGTHUNIT") { length_units.push(unit); }
    }
    if length_units.len() != 1 { return Err("one explicit project length unit is required".into()); }
    let unit = &length_units[0];
    if unit.ifc_type != IfcType::IfcSIUnit || unit.get(3).and_then(AttributeValue::as_enum) != Some("METRE") {
        return Err("map geometry normalization currently requires an SI metre project length unit".into());
    }
    if let Some(prefix) = unit.get(2).filter(|attr| !attr.is_null()) {
        // EXPRESS enumeration validation, not a second unit multiplier table.
        if !matches!(prefix.as_enum(), Some("EXA" | "PETA" | "TERA" | "GIGA" | "MEGA" | "KILO" |
            "HECTO" | "DECA" | "DECI" | "CENTI" | "MILLI" | "MICRO" | "NANO" | "PICO" | "FEMTO" | "ATTO")) {
            return Err("project SI prefix is invalid".into());
        }
    }
    Ok(())
}

pub(super) fn model(records: &[Record<'_>], context: u32, decoder: &mut EntityDecoder) -> Result<(), String> {
    let source_context = decoder.decode_by_id(context).map_err(|error| error.to_string())?;
    if source_context.ifc_type != IfcType::IfcGeometricRepresentationContext || source_context.get_float(2) != Some(3.0) {
        return Err(format!("SourceCRS #{context} is not a 3D representation context"));
    }
    let world = required(&source_context, 4, decoder)?;
    axis(&world, decoder)?;
    let location = required(&world, 0, decoder)?;
    if components(&location, 0)?.iter().any(|value| *value != 0.0)
        || !identity_direction(&world, 1, 2, decoder)? || !identity_direction(&world, 2, 0, decoder)? {
        return Err(format!("context #{context} has a non-identity WorldCoordinateSystem"));
    }
    let mut owners: HashMap<u32, u32> = HashMap::new();
    let mut body_shapes = HashSet::new();
    let mut mapped_sources = HashSet::new();
    for record in records {
        let kind = &record.kind;
        if kind.is_subtype_of(IfcType::IfcAnnotation) || kind.is_subtype_of(IfcType::IfcAlignment)
            || kind.is_subtype_of(IfcType::IfcStructuralItem) || kind.is_subtype_of(IfcType::IfcConnectionGeometry)
            || matches!(kind, IfcType::IfcShapeAspect | IfcType::IfcRelVoidsElement | IfcType::IfcRelFillsElement |
                IfcType::IfcGrid | IfcType::IfcGridPlacement | IfcType::IfcLinearPlacement) {
            return Err(format!("{} #{} has coordinate consumers not supported by body normalization", kind.name(), record.id));
        }
        if *kind == IfcType::IfcMappedItem {
            let item = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            mapped_sources.insert(item.get_ref(0).ok_or("mapped item has no MappingSource")?);
        }
        if *kind == IfcType::IfcProductDefinitionShape {
            let shape = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            let reps = shape.get_refs(2).filter(|reps| !reps.is_empty()).ok_or("ProductDefinitionShape has no Representations")?;
            for rep in reps {
                if owners.insert(rep, record.id).is_some() {
                    return Err(format!("shape representation #{rep} has multiple definition owners"));
                }
                body_shapes.insert(rep);
                representation(rep, context, decoder)?;
            }
        }
    }
    for record in records {
        if record.kind == IfcType::IfcRepresentationMap {
            let map = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            if map.get_ref(1).is_some_and(|id| body_shapes.contains(&id)) {
                return Err(format!("representation map #{} shares a product body representation", record.id));
            }
        }
        if record.kind.is_subtype_of(IfcType::IfcTypeProduct) {
            let product = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            if product.get_refs(6).is_some_and(|maps| maps.iter().any(|id| !mapped_sources.contains(id))) {
                return Err(format!("type product #{} has uninstantiated geometry", record.id));
            }
        }
        if record.kind.is_subtype_of(IfcType::IfcProduct) {
            let product = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            if let Some(attr) = product.get(6).filter(|attr| !attr.is_null()) {
                let id = attr.as_entity_ref().ok_or("product Representation is not a reference")?;
                let shape = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
                if shape.ifc_type != IfcType::IfcProductDefinitionShape {
                    return Err(format!("product #{} does not use a ProductDefinitionShape", product.id));
                }
            }
        }
    }
    Ok(())
}

fn representation(id: u32, context: u32, decoder: &mut EntityDecoder) -> Result<(), String> {
    let rep = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
    if rep.ifc_type != IfcType::IfcShapeRepresentation || rep.get_string(1) != Some("Body") {
        return Err(format!("representation #{id} is not a supported 3D Body shape"));
    }
    let mut current = rep.get_ref(0).ok_or("representation has no ContextOfItems")?;
    let mut seen = HashSet::new();
    while current != context {
        if seen.len() >= MAX_PLACEMENT_DEPTH || !seen.insert(current) {
            return Err(format!("representation #{id} context chain is cyclic or too deep"));
        }
        let node = decoder.decode_by_id(current).map_err(|error| error.to_string())?;
        if node.ifc_type != IfcType::IfcGeometricRepresentationSubContext {
            return Err(format!("representation #{id} belongs to another map context"));
        }
        current = node.get_ref(6).ok_or("subcontext has no ParentContext")?;
    }
    let items = rep.get_refs(3).filter(|items| !items.is_empty()).ok_or("body representation has no Items")?;
    for item in items { decoder.decode_by_id(item).map_err(|error| error.to_string())?; }
    Ok(())
}

pub(super) fn placement(product: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<(), String> {
    let Some(attr) = product.get(5).filter(|attr| !attr.is_null()) else { return Ok(()) };
    let mut current = attr.as_entity_ref().ok_or("ObjectPlacement is not a reference")?;
    let mut seen = HashSet::new();
    loop {
        if seen.len() >= MAX_PLACEMENT_DEPTH || !seen.insert(current) {
            return Err(format!("product #{} placement chain is cyclic or too deep", product.id));
        }
        let placement = decoder.decode_by_id(current).map_err(|error| error.to_string())?;
        if placement.ifc_type != IfcType::IfcLocalPlacement {
            return Err(format!("ObjectPlacement #{current} is not an IfcLocalPlacement"));
        }
        axis(&required(&placement, 1, decoder)?, decoder)?;
        let Some(parent) = placement.get(0).filter(|attr| !attr.is_null()) else { return Ok(()) };
        current = parent.as_entity_ref().ok_or("PlacementRelTo is not a reference")?;
    }
}

fn axis(frame: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<(), String> {
    if frame.ifc_type != IfcType::IfcAxis2Placement3D { return Err("only Axis2Placement3D frames are supported".into()); }
    let point = required(frame, 0, decoder)?;
    if point.ifc_type != IfcType::IfcCartesianPoint { return Err("placement Location is not a CartesianPoint".into()); }
    components(&point, 0)?;
    let mut directions = [Vector3::z(), Vector3::x()];
    for (slot, direction) in directions.iter_mut().enumerate() {
        if frame.get(slot + 1).is_some_and(|attr| !attr.is_null()) {
            let entity = required(frame, slot + 1, decoder)?;
            if entity.ifc_type != IfcType::IfcDirection { return Err("placement direction has the wrong type".into()); }
            *direction = components(&entity, 0)?;
            if !direction.norm().is_finite() || direction.norm() == 0.0 { return Err("placement direction is zero or unbounded".into()); }
        }
    }
    if directions[0].normalize().cross(&directions[1].normalize()).norm() <= 1e-12 {
        return Err("placement Axis and RefDirection are parallel".into());
    }
    Ok(())
}

fn identity_direction(frame: &DecodedEntity, slot: usize, component: usize, decoder: &mut EntityDecoder) -> Result<bool, String> {
    if frame.get(slot).is_none_or(|attr| attr.is_null()) { return Ok(true); }
    let direction = required(frame, slot, decoder)?;
    let values = components(&direction, 0)?;
    Ok((0..3).all(|index| if index == component { values[index] > 0.0 } else { values[index] == 0.0 }))
}

fn required(node: &DecodedEntity, slot: usize, decoder: &mut EntityDecoder) -> Result<DecodedEntity, String> {
    let id = node.get_ref(slot).ok_or_else(|| format!("entity #{} has a missing reference in slot {slot}", node.id))?;
    decoder.decode_by_id(id).map_err(|error| error.to_string())
}

fn components(node: &DecodedEntity, slot: usize) -> Result<Vector3<f64>, String> {
    let items = node.get_list(slot).filter(|items| items.len() == 3).ok_or("frame requires exactly three coordinates")?;
    let values: Option<Vec<_>> = items.iter().map(AttributeValue::as_float).collect();
    let values = values.filter(|values| values.iter().all(|value| value.is_finite())).ok_or("frame coordinates must be finite numbers")?;
    Ok(Vector3::from_column_slice(&values))
}

pub(super) fn rigid_frame(frame: &Matrix4<f64>, id: u32) -> Result<(), String> {
    let rotation = frame.fixed_view::<3, 3>(0, 0);
    if !frame.iter().all(|value| value.is_finite()) || (rotation.transpose() * rotation - nalgebra::Matrix3::identity()).amax() > 1e-10
        || (rotation.determinant() - 1.0).abs() > 1e-10 {
        return Err(format!("product #{id} has a non-rigid or non-finite placement frame"));
    }
    Ok(())
}
