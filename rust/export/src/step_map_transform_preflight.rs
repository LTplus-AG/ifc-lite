// SPDX-License-Identifier: MPL-2.0
//! Fail-closed semantic checks for map normalization; placement math remains
//! in GeometryRouter. These walks only validate file-controlled references.

use std::collections::{HashMap, HashSet};
use ifc_lite_core::slot::{self, kind, Slot};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcType, MAX_CONTEXT_DEPTH};
use ifc_lite_geometry::placement::{ChainValidator, ChainPolicy, LinkKind};
use ifc_lite_geometry::GeometryRouter;
use nalgebra::{Matrix4, Vector3};
use super::Record;

/// The `UnitType` of an `IfcUnit`, or `None` for one that declares none.
/// `IfcNamedUnit` and `IfcDerivedUnit` both keep it at position 1, and a
/// project's unit list holds either (and, in a malformed file, anything), so
/// the slot is chosen by the entity's own class.
pub(crate) fn unit_type(unit: &DecodedEntity) -> Option<&str> {
    if unit.ifc_type == IfcType::IfcDerivedUnit {
        unit.enum_at(slot::IfcDerivedUnit::UNIT_TYPE)
    } else if unit.ifc_type.is_subtype_of(IfcType::IfcNamedUnit) {
        unit.enum_at(slot::IfcNamedUnit::UNIT_TYPE)
    } else {
        None
    }
}

pub(crate) fn operation(map: &DecodedEntity) -> Result<(), String> {
    for slot in 2..=7 {
        if slot >= 5 && map.get(slot).is_some_and(|attr| attr.is_null()) { continue; }
        let value = map.get_float(slot).filter(|value| value.is_finite())
            .ok_or_else(|| format!("map conversion #{} has invalid numeric slot {slot}", map.id))?;
        if slot == 7 && value <= 0.0 { return Err("map Scale must be positive".into()); }
    }
    let x = map.real_at(slot::IfcMapConversion::X_AXIS_ABSCISSA).unwrap_or(1.0);
    let y = map.real_at(slot::IfcMapConversion::X_AXIS_ORDINATE).unwrap_or(0.0);
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
    let attr = target.attr(slot::IfcProjectedCRS::MAP_UNIT).ok_or("ProjectedCRS is missing its MapUnit slot")?;
    if attr.is_null() {
        // IFC's omitted MapUnit inherits the *validated* project length unit.
        return if project_metres == 1.0 { Ok(()) } else {
            Err("normalize map units to metres before normalizing map geometry".into())
        };
    }
    let unit = required(target, slot::IfcProjectedCRS::MAP_UNIT, decoder)?;
    if unit.ifc_type != IfcType::IfcSIUnit
        || unit_type(&unit) != Some("LENGTHUNIT")
        || !unit.attr(slot::IfcSIUnit::PREFIX).is_some_and(AttributeValue::is_null)
        || unit.enum_at(slot::IfcSIUnit::NAME) != Some("METRE") {
        return Err(format!("ProjectedCRS #{} MapUnit #{} is not an explicit SI metre length unit; normalize units first", target.id, unit.id));
    }
    Ok(())
}

pub(super) fn project_units(project: u32, decoder: &mut EntityDecoder) -> Result<(), String> {
    let project = decoder.decode_by_id(project).map_err(|error| error.to_string())?;
    let assignment = required(&project, slot::IfcProject::UNITS_IN_CONTEXT, decoder)?;
    if assignment.ifc_type != IfcType::IfcUnitAssignment { return Err("invalid project unit assignment".into()); }
    let mut length_units = Vec::new();
    for id in assignment.ref_list_at(slot::IfcUnitAssignment::UNITS).ok_or("project Units list is invalid")? {
        let unit = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
        if unit_type(&unit) == Some("LENGTHUNIT") { length_units.push(unit); }
    }
    if length_units.len() != 1 { return Err("one explicit project length unit is required".into()); }
    let unit = &length_units[0];
    if unit.ifc_type != IfcType::IfcSIUnit || unit.enum_at(slot::IfcSIUnit::NAME) != Some("METRE") {
        return Err("map geometry normalization currently requires an SI metre project length unit".into());
    }
    if let Some(prefix) = unit.attr(slot::IfcSIUnit::PREFIX).filter(|attr| !attr.is_null()) {
        // EXPRESS enumeration validation against the one `IfcSIPrefix` table.
        if prefix.as_enum().is_none_or(|token| ifc_lite_core::si_prefix(token).is_none()) {
            return Err("project SI prefix is invalid".into());
        }
    }
    Ok(())
}

/// Validates the scaled path's model and returns the type `RepresentationMap`s
/// no product representation instantiates, sorted. The planner wraps those at
/// type level with the same similarity (#6634's concern, now satisfied rather
/// than refused): left unscaled, they would be wrong once instantiated.
pub(super) fn model(records: &[Record<'_>], context: u32, decoder: &mut EntityDecoder) -> Result<Vec<u32>, String> {
    context_frame(context, decoder)?;
    let mut owners: HashMap<u32, u32> = HashMap::new();
    let mut body_shapes = HashSet::new();
    let mut used_representations = HashSet::new();
    for record in records {
        let kind = &record.kind;
        // Alignments, annotations and linear placements are ordinary products
        // and placements here: every product gets a fresh root frame (#7359).
        if kind.is_subtype_of(IfcType::IfcStructuralItem) || kind.is_subtype_of(IfcType::IfcConnectionGeometry)
            || matches!(kind, IfcType::IfcShapeAspect | IfcType::IfcRelVoidsElement | IfcType::IfcRelFillsElement |
                IfcType::IfcGrid | IfcType::IfcGridPlacement) {
            return Err(format!("{} #{} has coordinate consumers not supported by body normalization", kind.name(), record.id));
        }
        if *kind == IfcType::IfcProductDefinitionShape {
            let shape = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            let reps = shape.ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS).filter(|reps| !reps.is_empty()).ok_or("ProductDefinitionShape has no Representations")?;
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
            if map.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).is_some_and(|id| body_shapes.contains(&id)) {
                return Err(format!("representation map #{} shares a product body representation", record.id));
            }
        }
        if record.kind.is_subtype_of(IfcType::IfcProduct) {
            let product = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            if let Some(attr) = product.attr(slot::IfcProduct::REPRESENTATION).filter(|attr| !attr.is_null()) {
                let id = attr.as_entity_ref().ok_or("product Representation is not a reference")?;
                let shape = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
                if shape.ifc_type != IfcType::IfcProductDefinitionShape {
                    return Err(format!("product #{} does not use a ProductDefinitionShape", product.id));
                }
                used_representations.extend(shape.ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS).ok_or("product shape has no Representations")?);
            }
        }
    }
    let allowance = records.len().saturating_mul(ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH as usize);
    let mapped_sources = body_mapped_sources(&used_representations, context, decoder, allowance)?;
    let mut type_maps = std::collections::BTreeSet::new();
    for record in records.iter().filter(|record| record.kind.is_subtype_of(IfcType::IfcTypeProduct)) {
        let product = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
        if let Some(attr) = product.attr(slot::IfcTypeProduct::REPRESENTATION_MAPS).filter(|attr| !attr.is_null()) {
            let maps = attr.as_list().ok_or("type RepresentationMaps is not a list")?;
            for map in maps {
                let map = map.as_entity_ref().ok_or("type RepresentationMaps holds a non-reference")?;
                if !mapped_sources.contains(&map) { type_maps.insert(map); }
            }
        }
    }
    // Their representations meet the same context, item and wrapper-depth
    // rules as product representations. A type map reached from another one
    // would be scaled twice when the outer one is instantiated: refuse it.
    let mut roots = HashSet::new();
    for map in &type_maps {
        let node = decoder.decode_by_id(*map).map_err(|error| error.to_string())?;
        if node.ifc_type != IfcType::IfcRepresentationMap {
            return Err(format!("type RepresentationMaps entry #{map} is not an IfcRepresentationMap"));
        }
        roots.insert(node.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or("type map has no MappedRepresentation")?);
    }
    // A type map is reached through its new type-level wrapper and then
    // through the consumer's own instance item: reserve both levels.
    let nested = mapped_sources_reserving(&roots, context, decoder, allowance, 2)?;
    if let Some(map) = type_maps.iter().find(|map| nested.contains(map)) {
        return Err(format!("uninstantiated type map #{map} is nested in other uninstantiated type geometry"));
    }
    Ok(type_maps.into_iter().collect())
}

/// Pure reachable-ID set: memoization is global, unlike mesh accumulation.
/// Only actual product Body roots confer ownership; orphan items do not.
pub(super) fn body_mapped_sources(roots: &HashSet<u32>, context: u32, decoder: &mut EntityDecoder, max_work: usize) -> Result<HashSet<u32>, String> {
    mapped_sources_reserving(roots, context, decoder, max_work, 1)
}

/// [`body_mapped_sources`] with `added_levels` mapped levels reserved above
/// each root: 1 for a product representation's wrapper, 2 for a type map's
/// type-level wrapper plus a consumer's instance item.
fn mapped_sources_reserving(roots: &HashSet<u32>, context: u32, decoder: &mut EntityDecoder, max_work: usize, added_levels: usize) -> Result<HashSet<u32>, String> {
    let mut pending: Vec<_> = roots.iter().map(|id| (*id, false)).collect();
    let mut seen = HashSet::new();
    let mut active = HashSet::new();
    let mut sources = HashSet::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut depths: HashMap<u32, usize> = HashMap::new();
    let mut work = pending.len();
    while let Some((id, exiting)) = pending.pop() {
        if exiting {
            // A representation's longest mapped path is a pure ID result.
            // Postorder memoization also handles aliases reached at different
            // depths; an entry-time global visited set alone cannot do that.
            let depth = if let Some(children) = children.get(&id) {
                children.iter().try_fold(0usize, |longest, child| {
                    depths.get(child).copied().map(|depth| longest.max(depth))
                        .ok_or("Body map nesting could not be resolved")
                })?.saturating_add(1)
            } else { 0 };
            // The emitted Body adds a mapped wrapper; submesh collection also
            // charges the terminal leaf. Reserve both levels to preserve
            // authored styles, not merely the cached aggregate geometry.
            if depth.saturating_add(added_levels) >= ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH as usize {
                return Err(if added_levels > 1 {
                    "type map nesting leaves no room for the type-level normalization wrapper and an instance".into()
                } else {
                    "Body map nesting leaves no room for the normalization wrapper".into()
                });
            }
            depths.insert(id, depth);
            active.remove(&id);
            continue;
        }
        if work > max_work { return Err("Body map reachability exceeded its reference-work bound".into()); }
        if !seen.insert(id) { continue; }
        active.insert(id);
        pending.push((id, true));
        representation(id, context, decoder)?;
        let rep = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
        let items = rep.ref_list_at(slot::IfcRepresentation::ITEMS).ok_or("Body representation has no Items")?;
        work = work.checked_add(items.len()).filter(|value| *value <= max_work)
            .ok_or("Body map reachability exceeded its reference-work bound")?;
        for item_id in items {
            let item = decoder.decode_by_id(item_id).map_err(|error| error.to_string())?;
            if !item.ifc_type.is_subtype_of(IfcType::IfcRepresentationItem) {
                return Err(format!("Body item #{item_id} is not an IfcRepresentationItem"));
            }
            if item.ifc_type != IfcType::IfcMappedItem { continue; }
            let source = required(&item, slot::IfcMappedItem::MAPPING_SOURCE, decoder)?;
            if source.ifc_type != IfcType::IfcRepresentationMap { return Err("mapped MappingSource is not a RepresentationMap".into()); }
            let child = source.ref_at(slot::IfcRepresentationMap::MAPPED_REPRESENTATION).ok_or("map has no MappedRepresentation")?;
            if active.contains(&child) { return Err(format!("Body mapped representation #{child} is cyclic")); }
            sources.insert(source.id);
            work = work.checked_add(1).filter(|value| *value <= max_work)
                .ok_or("Body map reachability exceeded its reference-work bound")?;
            children.entry(id).or_default().push(child);
            pending.push((child, false));
        }
    }
    Ok(sources)
}

fn representation(id: u32, context: u32, decoder: &mut EntityDecoder) -> Result<(), String> {
    let rep = decoder.decode_by_id(id).map_err(|error| error.to_string())?;
    if rep.ifc_type != IfcType::IfcShapeRepresentation {
        return Err(format!("representation #{id} is not an IfcShapeRepresentation"));
    }
    let mut current = rep.ref_at(slot::IfcRepresentation::CONTEXT_OF_ITEMS).ok_or("representation has no ContextOfItems")?;
    let mut seen = HashSet::new();
    while current != context {
        if seen.len() >= MAX_CONTEXT_DEPTH || !seen.insert(current) {
            return Err(format!("representation #{id} context chain is cyclic or too deep"));
        }
        let node = decoder.decode_by_id(current).map_err(|error| error.to_string())?;
        if node.ifc_type != IfcType::IfcGeometricRepresentationSubContext {
            return Err(format!("representation #{id} belongs to another map context"));
        }
        current = node.ref_at(slot::IfcGeometricRepresentationSubContext::PARENT_CONTEXT).ok_or("subcontext has no ParentContext")?;
    }
    let items = rep.ref_list_at(slot::IfcRepresentation::ITEMS).filter(|items| !items.is_empty()).ok_or("representation has no Items")?;
    // The scaled wrapper is covariant for any item, but it reads as
    // `MappedRepresentation`, which renderers classify as body geometry. A
    // non-Body representation is carried only when it is curve or point
    // geometry (alignment `Axis`, `FootPrint`), which renders no surface
    // before or after wrapping (#7359); annotation fills, boxes and other
    // surfaces stay refused rather than silently start rendering.
    let body = rep.string_at(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER) == Some("Body");
    for item in items {
        let item = decoder.decode_by_id(item).map_err(|error| error.to_string())?;
        if !body && !curve_geometry(&item, decoder)? {
            return Err(format!("representation #{id} is neither a Body nor curve geometry ({} #{})", item.ifc_type.name(), item.id));
        }
    }
    Ok(())
}

/// Curves, curve segments and points; a curve set only when every member is
/// one of those (a single attribute list, so the check is bounded).
fn curve_geometry(item: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<bool, String> {
    let primitive = |kind: &IfcType| kind.is_subtype_of(IfcType::IfcCurve)
        || kind.is_subtype_of(IfcType::IfcSegment) || kind.is_subtype_of(IfcType::IfcPoint);
    if primitive(&item.ifc_type) { return Ok(true); }
    if item.ifc_type != IfcType::IfcGeometricCurveSet { return Ok(false); }
    for element in item.ref_list_at(slot::IfcGeometricCurveSet::ELEMENTS).ok_or("GeometricCurveSet Elements is invalid")? {
        let element = decoder.decode_by_id(element).map_err(|error| error.to_string())?;
        if !primitive(&element.ifc_type) { return Ok(false); }
    }
    Ok(true)
}

/// What map normalization carries in a placement chain: local and linear
/// links, 3D frames with exactly 3 finite coordinates, non-zero and
/// non-parallel axes. Grid placements are refused.
pub(crate) const CHAIN_POLICY: ChainPolicy =
    ChainPolicy { grid: false, linear: true, planar_relative: false, strict_spatial: true };

/// Validates a product's placement chain with the shared walk (visited set, no
/// depth cap, D27) and [`CHAIN_POLICY`]. The session memoizes whole verified
/// chains, so shared parents and their linear curve samples are checked once.
pub(crate) fn placement(product: &DecodedEntity, router: &GeometryRouter, validator: &mut ChainValidator) -> Result<(), String> {
    let Some(attr) = product.attr(slot::IfcProduct::OBJECT_PLACEMENT).filter(|attr| !attr.is_null()) else { return Ok(()) };
    let leaf = attr.as_entity_ref().ok_or("ObjectPlacement is not a reference")?;
    let describe = |error: ifc_lite_geometry::placement::PlacementError| format!("product #{} placement: {error}", product.id);
    let (_, links) = validator.validate(leaf).map_err(describe)?;
    let decoder = validator.decoder();
    for link in &links {
        // The product's fresh root frame is composed through the whole chain,
        // so a linear placement, with or without PlacementRelTo, is evaluated
        // once and then bypassed (#7359). Refuse where rendering would
        // silently fall back to an identity frame.
        if link.kind == LinkKind::Linear {
            let placement = decoder.decode_by_id(link.id).map_err(|error| error.to_string())?;
            router.resolve_linear_placement_local_strict(&placement, decoder).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn axis(frame: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<(), String> {
    ifc_lite_geometry::placement::validate_spatial_frame(frame, decoder).map_err(|error| error.to_string())
}

fn identity_direction(frame: &DecodedEntity, at: Slot<kind::Ref>, component: usize, decoder: &mut EntityDecoder) -> Result<bool, String> {
    if frame.attr(at).is_none_or(|attr| attr.is_null()) { return Ok(true); }
    let direction = required(frame, at, decoder)?;
    let values = components(&direction, slot::IfcDirection::DIRECTION_RATIOS)?;
    Ok((0..3).all(|index| if index == component { values[index] > 0.0 } else { values[index] == 0.0 }))
}

fn required(node: &DecodedEntity, at: Slot<kind::Ref>, decoder: &mut EntityDecoder) -> Result<DecodedEntity, String> {
    let id = node.ref_at(at).ok_or_else(|| format!("entity #{} has a missing reference in slot {}", node.id, at.index()))?;
    decoder.decode_by_id(id).map_err(|error| error.to_string())
}

fn components(node: &DecodedEntity, at: Slot<kind::List>) -> Result<Vector3<f64>, String> {
    let items = node.list_at(at).filter(|items| items.len() == 3).ok_or("frame requires exactly three coordinates")?;
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

/// Both normalization paths require the same engineering context frame.
pub(crate) fn context_frame(context: u32, decoder: &mut EntityDecoder) -> Result<(), String> {
    let source_context = decoder.decode_by_id(context).map_err(|error| error.to_string())?;
    if source_context.ifc_type != IfcType::IfcGeometricRepresentationContext || source_context.attr(slot::IfcGeometricRepresentationContext::COORDINATE_SPACE_DIMENSION).and_then(AttributeValue::as_float) != Some(3.0) {
        return Err(format!("SourceCRS #{context} is not a 3D representation context"));
    }
    let world = required(&source_context, slot::IfcGeometricRepresentationContext::WORLD_COORDINATE_SYSTEM, decoder)?;
    axis(&world, decoder)?;
    let location = required(&world, slot::IfcAxis2Placement3D::LOCATION, decoder)?;
    if components(&location, slot::IfcCartesianPoint::COORDINATES)?.iter().any(|value| *value != 0.0)
        || !identity_direction(&world, slot::IfcAxis2Placement3D::AXIS, 2, decoder)? || !identity_direction(&world, slot::IfcAxis2Placement3D::REF_DIRECTION, 0, decoder)? {
        return Err(format!("context #{context} has a non-identity WorldCoordinateSystem"));
    }
    Ok(())
}
