// SPDX-License-Identifier: MPL-2.0
//! Unit physical scale: a common rigid transform belongs on placement roots.
//! Geometry, relative placement chains and endpoint-local connections stay intact.

use super::{preflight, writer, MapConversionNormalizationPlan, Record};
use ifc_lite_core::{EntityDecoder, IfcType, MAX_PLACEMENT_DEPTH};
use nalgebra::Matrix4;
use std::collections::{BTreeSet, HashMap, HashSet};

pub(super) fn plan(
    records: &[Record<'_>],
    ids: &HashMap<u32, usize>,
    map: &Record<'_>,
    context: u32,
    unit: f64,
    affine: &Matrix4<f64>,
    decoder: &mut EntityDecoder,
) -> Result<MapConversionNormalizationPlan, String> {
    preflight::context_frame(context, decoder)?;
    preflight::rigid_frame(affine, map.id)?;
    let mut roots = BTreeSet::new();
    let mut placements = HashMap::new();
    let mut representations = HashSet::new();
    let mut shapes = HashSet::new();
    let mut products = HashSet::new();
    for record in records {
        // Alignments and their linear placements are ordinary root-frame
        // consumers (see `placement_root`); grids and structural analysis
        // models carry frames this root edit does not own.
        if record.kind.is_subtype_of(IfcType::IfcStructuralItem)
            || matches!(record.kind, IfcType::IfcGrid | IfcType::IfcGridPlacement)
        {
            return Err(format!(
                "{} #{} has unsupported engineering-frame consumers",
                record.kind.name(),
                record.id
            ));
        }
        if !record.kind.is_subtype_of(IfcType::IfcProduct) {
            continue;
        }
        let product = decoder
            .decode_by_id(record.id)
            .map_err(|error| error.to_string())?;
        let shape = product.get(6).filter(|attr| !attr.is_null());
        let placement = product.get(5).filter(|attr| !attr.is_null());
        if let Some(attr) = placement {
            let id = attr
                .as_entity_ref()
                .ok_or("ObjectPlacement is not a reference")?;
            roots.insert(placement_root(id, &mut placements, decoder)?);
            products.insert(product.id);
        } else if shape.is_some() {
            return Err(format!(
                "represented product #{} has no ObjectPlacement",
                product.id
            ));
        }
        if let Some(attr) = shape {
            let id = attr
                .as_entity_ref()
                .ok_or("product Representation is not a reference")?;
            shapes.insert(id);
            let shape = decoder
                .decode_by_id(id)
                .map_err(|error| error.to_string())?;
            if shape.ifc_type != IfcType::IfcProductDefinitionShape {
                return Err(format!(
                    "product #{} does not use a ProductDefinitionShape",
                    product.id
                ));
            }
            representations.extend(
                shape
                    .get_refs(2)
                    .filter(|refs| !refs.is_empty())
                    .ok_or("ProductDefinitionShape has no Representations")?,
            );
        }
    }
    if roots.is_empty() {
        return Err("no represented placement roots to normalize".into());
    }
    super::rigid_ownership::validate(records, &products, &placements, decoder)?;
    let project_record = records
        .iter()
        .find(|record| record.kind == IfcType::IfcProject)
        .ok_or("project is missing")?;
    let project = decoder
        .decode_by_id(project_record.id)
        .map_err(|error| error.to_string())?;
    let declared: HashSet<_> = project
        .get_refs(7)
        .ok_or("Project RepresentationContexts is invalid")?
        .into_iter()
        .collect();
    if !declared.contains(&context) {
        return Err("map SourceCRS is outside the project contexts".into());
    }
    let contexts = super::rigid_contexts::representation_contexts(
        &representations,
        &shapes,
        records,
        &declared,
        context,
        decoder,
    )?;
    let mut output = writer::Writer::new(records)?;
    let mut plan = MapConversionNormalizationPlan::default();
    for id in roots {
        let placement = decoder
            .decode_by_id(id)
            .map_err(|error| error.to_string())?;
        let frame_id = placement
            .get_ref(1)
            .ok_or("root RelativePlacement is missing")?;
        let frame = decoder
            .decode_by_id(frame_id)
            .map_err(|error| error.to_string())?;
        // Validation already checked every axis. Reuse the renderer's canonical
        // orthonormalization; point and directions are in authored project units.
        let local = ifc_lite_geometry::parse_axis2_placement_3d(&frame, decoder)
            .map_err(|error| error.to_string())?;
        let normalized = affine * local;
        preflight::rigid_frame(&normalized, id)?;
        let new_frame = output.frame(&normalized)?;
        let record = &records[*ids.get(&id).ok_or("root placement record is absent")?];
        // Keep the original LocalPlacement ID and every child/relationship edge.
        // Clone its frame instead of editing shared CartesianPoint/Direction IDs.
        plan.replacements
            .push(writer::replace(record, &[(1, format!("#{new_frame}"))])?);
    }
    let mut edits = vec![
        (2, "0.".into()),
        (3, "0.".into()),
        (4, "0.".into()),
        (5, "1.".into()),
        (6, "0.".into()),
        (7, writer::real(unit)?),
    ];
    if map.kind == IfcType::IfcMapConversionScaled {
        edits.extend([(8, "1.".into()), (9, "1.".into()), (10, "1.".into())]);
    }
    plan.replacements.push(writer::replace(map, &edits)?);
    super::context_metadata::transform_north(
        records,
        ids,
        &contexts,
        affine,
        decoder,
        &mut output,
        &mut plan,
    )?;
    plan.new_entities = output.finish();
    Ok(plan)
}

/// Pure (root, path length) result: global memoization handles aliases without
/// repeating walks. Iterative traversal cannot exhaust the native/WASM stack.
fn placement_root(
    id: u32,
    memo: &mut HashMap<u32, (u32, usize)>,
    decoder: &mut EntityDecoder,
) -> Result<u32, String> {
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut current = id;
    let (root, mut depth) = loop {
        if let Some(result) = memo.get(&current) {
            break *result;
        }
        if path.len() >= MAX_PLACEMENT_DEPTH || !seen.insert(current) {
            return Err(format!(
                "ObjectPlacement #{id} is cyclic or exceeds the placement-work bound"
            ));
        }
        let placement = decoder
            .decode_by_id(current)
            .map_err(|error| error.to_string())?;
        let parent = placement.get(0).filter(|attr| !attr.is_null());
        match placement.ifc_type {
            IfcType::IfcLocalPlacement => {
                let frame = decoder
                    .decode_by_id(placement.get_ref(1).ok_or("RelativePlacement is missing")?)
                    .map_err(|error| error.to_string())?;
                preflight::axis(&frame, decoder)?;
            }
            // The renderer composes PlacementRelTo * (curve sample or
            // CartesianPosition), both expressed in the parent frame, so a
            // rigid edit of the parent's root carries them exactly. Without a
            // parent the basis curve is read in the untransformed world frame.
            IfcType::IfcLinearPlacement if parent.is_some() => {}
            IfcType::IfcLinearPlacement => {
                return Err(format!(
                    "IfcLinearPlacement #{current} has no PlacementRelTo to carry its basis curve"
                ));
            }
            _ => {
                return Err(format!(
                    "ObjectPlacement #{current} is not an IfcLocalPlacement or IfcLinearPlacement"
                ));
            }
        }
        path.push(current);
        match parent {
            None => break (current, 0),
            Some(attr) => {
                current = attr
                    .as_entity_ref()
                    .ok_or("PlacementRelTo is not a reference")?
            }
        }
    };
    for id in path.into_iter().rev() {
        depth += 1;
        if depth > MAX_PLACEMENT_DEPTH {
            return Err("ObjectPlacement exceeds the placement-work bound".into());
        }
        memo.insert(id, (root, depth));
    }
    Ok(root)
}
