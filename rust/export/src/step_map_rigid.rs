// SPDX-License-Identifier: MPL-2.0
//! Unit physical scale: a common rigid transform belongs on placement roots.
//! Geometry, relative placement chains and endpoint-local connections stay intact.

use super::{preflight, writer, MapConversionNormalizationPlan, Record};
use crate::step_text::attribute_of;
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};
use ifc_lite_geometry::placement::{ChainValidator, LinkKind};
use ifc_lite_geometry::GeometryRouter;
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
    let PlacementConsumers { roots, placements, representations, shapes, products } =
        placement_consumers(records, decoder)?;
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
        .ref_list_at(slot::IfcProject::REPRESENTATION_CONTEXTS)
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
            .ref_at(slot::IfcLocalPlacement::RELATIVE_PLACEMENT)
            .ok_or("root RelativePlacement is missing")?;
        let frame = decoder
            .decode_by_id(frame_id)
            .map_err(|error| error.to_string())?;
        // Validation checked every axis; reuse canonical orthonormalization in file units.
        let local = ifc_lite_geometry::placement::Axis2Placement::read_3d(&frame, decoder)
            .map(|placement| placement.matrix())
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
    // Cesium ion evaluates IfcLinearPlacement in the world frame, ignoring a
    // transformed PlacementRelTo root (live asset 6005950 put ~5,900 parts
    // near map origin 0,0). Bake each reached linear placement into the
    // IfcLocalPlacement rendering already composes: same ID and parent, its
    // resolved curve or CartesianPosition frame (#7335).
    let router = GeometryRouter::with_scale(unit);
    let mut linear: Vec<_> = placements.keys().copied().collect();
    linear.sort_unstable();
    for id in linear {
        let record = &records[*ids.get(&id).ok_or("placement record is absent")?];
        if record.kind != IfcType::IfcLinearPlacement {
            continue;
        }
        let placement = decoder
            .decode_by_id(id)
            .map_err(|error| error.to_string())?;
        let local = Matrix4::from_column_slice(
            &router
                .resolve_linear_placement_local_strict(&placement, decoder)
                .map_err(|error| error.to_string())?,
        );
        preflight::rigid_frame(&local, id)?;
        let frame = output.frame(&local)?;
        let parent = attribute_of(record.line, 0).ok_or("linear PlacementRelTo is invalid")?;
        let parent = parent.trim();
        plan.replacements.push(writer::retype(
            record,
            "IFCLOCALPLACEMENT",
            format!("{parent},#{frame}"),
        ));
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

#[derive(Default)]
struct PlacementConsumers {
    roots: BTreeSet<u32>,
    placements: HashMap<u32, u32>,
    representations: HashSet<u32>,
    shapes: HashSet<u32>,
    products: HashSet<u32>,
}

/// Discover and verify the source's consumers once under a fixed policy.
fn placement_consumers(records: &[Record<'_>], decoder: &mut EntityDecoder) -> Result<PlacementConsumers, String> {
    let mut consumers = PlacementConsumers::default();
    let mut validator = ChainValidator::new(decoder, preflight::CHAIN_POLICY);
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
        let product = validator.decoder()
            .decode_by_id(record.id)
            .map_err(|error| error.to_string())?;
        let shape = product.attr(slot::IfcProduct::REPRESENTATION).filter(|attr| !attr.is_null());
        let placement = product.attr(slot::IfcProduct::OBJECT_PLACEMENT).filter(|attr| !attr.is_null());
        if let Some(attr) = placement {
            let id = attr
                .as_entity_ref()
                .ok_or("ObjectPlacement is not a reference")?;
            consumers.roots.insert(placement_root(id, &mut consumers.placements, &mut validator)?);
            consumers.products.insert(product.id);
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
            consumers.shapes.insert(id);
            let shape = validator.decoder()
                .decode_by_id(id)
                .map_err(|error| error.to_string())?;
            if shape.ifc_type != IfcType::IfcProductDefinitionShape {
                return Err(format!(
                    "product #{} does not use a ProductDefinitionShape",
                    product.id
                ));
            }
            consumers.representations.extend(
                shape
                    .ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS)
                    .filter(|refs| !refs.is_empty())
                    .ok_or("ProductDefinitionShape has no Representations")?,
            );
        }
    }
    Ok(consumers)
}

/// The renderer's canonical frame for an `IfcAxis2Placement3D`.
fn local_frame(frame: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<Matrix4<f64>, String> {
    let placement = ifc_lite_geometry::placement::Axis2Placement::read_3d(frame, decoder);
    Ok(placement.map_err(|error| error.to_string())?.matrix())
}

/// The root of `id`'s placement chain, after validating it with the shared
/// walk (visited set, no depth cap, D27) under the preflight policy. The
/// memo is per placement id, so aliases are not walked twice.
fn placement_root(
    id: u32,
    memo: &mut HashMap<u32, u32>,
    validator: &mut ChainValidator,
) -> Result<u32, String> {
    if let Some(root) = memo.get(&id) {
        return Ok(*root);
    }
    let (root, links) = validator.validate(id).map_err(|error| error.to_string())?;
    // A linear placement is baked below into an IfcLocalPlacement relative to
    // the same parent. Without a parent the basis curve is read in the
    // untransformed world frame, which a root edit cannot carry.
    for link in links.iter().filter(|link| link.kind == LinkKind::Linear) {
        let placement = validator.decoder().decode_by_id(link.id).map_err(|error| error.to_string())?;
        if placement.attr(slot::IfcObjectPlacement::PLACEMENT_REL_TO).is_none_or(|attr| attr.is_null()) {
            return Err(format!(
                "IfcLinearPlacement #{} has no PlacementRelTo to carry its basis curve",
                link.id
            ));
        }
    }
    for link in &links {
        memo.insert(link.id, root);
    }
    Ok(root)
}
