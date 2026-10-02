// SPDX-License-Identifier: MPL-2.0
//! Opt-in coordinate compatibility export: move a uniform map similarity into
//! logical product placements and mapped body geometry, preserving map points.

use std::collections::{BTreeMap, HashMap};
use ifc_lite_core::{EntityDecoder, EntityScanner, GeoRefExtractor, IfcType};
use ifc_lite_geometry::GeometryRouter;
use nalgebra::Matrix4;
use serde::Serialize;

#[path = "step_map_transform_preflight.rs"]
mod preflight;
#[path = "step_map_transform_writer.rs"]
mod writer;

/// A complete replacement or newly allocated STEP entity. IDs let the host
/// exporter settle its existing modification ledger without counting edits twice.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapConversionEntityPatch {
    pub express_id: u32,
    pub line: String,
}

/// Atomic plan applied to the already mutation-resolved export pass. Warnings
/// mean no geometry/context patches were produced; upload must refuse them.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapConversionNormalizationPlan {
    pub replacements: Vec<MapConversionEntityPatch>,
    pub new_entities: Vec<MapConversionEntityPatch>,
    pub warnings: Vec<String>,
}

pub(super) struct Record<'a> { pub id: u32, pub kind: IfcType, pub line: &'a str }

/// Plan a standards-valid, uniform 3D `IfcMapConversion` compatibility export.
/// Default STEP export never calls this. For project unit u metres, physical
/// similarity s = MapScale/u, and native map affine A = [R*s,T/u], emit
/// P_new = A*P*S^-1 and representation scale S=s. Therefore P_new*S=A*P,
/// while logical placement origins also represent the same physical map point.
/// The neutral remaining conversion is offsets 0, axes identity, Scale=u.
pub fn plan_map_conversion_normalization(content: &[u8]) -> Result<MapConversionNormalizationPlan, String> {
    let text = std::str::from_utf8(content).map_err(|_| "map normalization requires UTF-8 STEP".to_string())?;
    let mut scanner = EntityScanner::new(content);
    let mut records = Vec::new();
    let mut ids = HashMap::new();
    while let Some((id, name, start, end)) = scanner.next_entity() {
        if ids.insert(id, records.len()).is_some() {
            return Err(format!("map normalization refuses duplicate entity #{id}"));
        }
        let line = text.get(start..end).ok_or("invalid STEP record boundary")?;
        records.push(Record { id, kind: IfcType::from_str(name), line });
    }
    let maps: Vec<_> = records.iter().filter(|record| matches!(record.kind,
        IfcType::IfcMapConversion | IfcType::IfcMapConversionScaled)).collect();
    if maps.is_empty() { return Ok(MapConversionNormalizationPlan::default()); }
    let attempt = || -> Result<MapConversionNormalizationPlan, String> {
        let schema = crate::source_header::declared_schema(content)
            .ok_or("map normalization requires a declared source schema")?.to_ascii_uppercase();
        if schema != "IFC4" && !schema.starts_with("IFC4_ADD")
            && schema != "IFC4X3" && !schema.starts_with("IFC4X3_ADD") {
            return Err(format!("source schema {schema} is not supported by map normalization"));
        }
        if maps.len() != 1 { return Err("multiple map conversions are not supported atomically".into()); }
        let map = maps[0];
        let mut decoder = EntityDecoder::new(&content);
        let operation = decoder.decode_by_id(map.id).map_err(|error| error.to_string())?;
        preflight::operation(&operation)?;
        let target_id = operation.get_ref(1).ok_or("map TargetCRS is missing")?;
        let target = decoder.decode_by_id(target_id).map_err(|error| error.to_string())?;
        if target.ifc_type != IfcType::IfcProjectedCRS { return Err("map TargetCRS is not an IfcProjectedCRS".into()); }
        // Select the operation's actual target, not the first unrelated CRS in
        // file order, while reusing the canonical transform/unit extraction.
        let types = [(map.id, map.kind.clone()), (target_id, IfcType::IfcProjectedCRS)];
        let projects: Vec<_> = records.iter().filter(|record| record.kind == IfcType::IfcProject).collect();
        if projects.len() != 1 { return Err("exactly one IfcProject is required".into()); }
        preflight::project_units(projects[0].id, &mut decoder)?;
        let unit = ifc_lite_core::try_extract_length_unit_scale(&mut decoder, projects[0].id)
            .ok_or("project length unit cannot be resolved")?;
        if !unit.is_finite() || unit <= 0.0 { return Err("project length unit is not positive and finite".into()); }
        // The renderer's canonical extractor is intentionally tolerant of
        // bad unit metadata. A writer must not interpret that fallback as a
        // permission to bake coordinates: validate the authored target first.
        preflight::map_unit(&target, unit, &mut decoder)?;
        let geo = GeoRefExtractor::extract(&mut decoder, &types)
            .map_err(|error| error.to_string())?.filter(|geo| geo.has_map_conversion)
            .ok_or_else(|| format!("map conversion #{} cannot be resolved exactly", map.id))?;
        if geo.factor_x != 1.0 || geo.factor_y != 1.0 || geo.factor_z != 1.0 {
            return Err("per-axis map factors are not supported by uniform mapped normalization".into());
        }
        let scale = geo.scale / unit;
        let mut affine = Matrix4::from_column_slice(&geo.to_matrix());
        for row in 0..3 { for col in 0..4 { affine[(row, col)] /= unit; } }
        if !scale.is_finite() || scale <= 0.0 || !affine.iter().all(|value| value.is_finite()) {
            return Err("map similarity is not positive and finite".into());
        }
        // Zero-angle exporters can retain a sine roundoff (for example cos(PI/2)).
        // Recognize only machine-precision direction noise; physical scale and
        // cosine stay exact. Preserve the authored operation, including the tiny
        // ordinate and offsets: this returns no patches, not a snapped transform.
        if scale == 1.0 && geo.x_axis_abscissa == 1.0 && geo.x_axis_ordinate.abs() <= f64::EPSILON {
            return Ok(MapConversionNormalizationPlan::default());
        }
        let context = operation.get_ref(0).ok_or("map SourceCRS is missing")?;
        preflight::model(&records, context, &mut decoder)?;
        let router = GeometryRouter::with_scale(unit);
        let mut plan = MapConversionNormalizationPlan::default();
        let mut output = writer::Writer::new(&records)?;
        let inverse_scale = Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(1.0 / scale));
        let mut shapes = BTreeMap::new();
        for record in records.iter().filter(|record| record.kind.is_subtype_of(IfcType::IfcProduct)) {
            let product = decoder.decode_by_id(record.id).map_err(|error| error.to_string())?;
            preflight::placement(&product, &mut decoder)?;
            let matrix = router.resolve_scaled_placement_strict(&product, &mut decoder)
                .map_err(|error| error.to_string())?;
            let mut placement = Matrix4::from_column_slice(&matrix);
            for row in 0..3 { placement[(row, 3)] /= unit; }
            let normalized = affine * placement * inverse_scale;
            preflight::rigid_frame(&normalized, record.id)?;
            let new_placement = output.placement(&normalized)?;
            plan.replacements.push(writer::replace(record, &[(5, format!("#{new_placement}"))])?);
            if let Some(shape) = product.get_ref(6) { shapes.insert(shape, ()); }
        }
        for shape_id in shapes.keys() {
            let shape = decoder.decode_by_id(*shape_id).map_err(|error| error.to_string())?;
            let reps = shape.get_refs(2).ok_or("ProductDefinitionShape has no Representations")?;
            let mut mapped = Vec::new();
            for rep_id in reps {
                let record = &records[*ids.get(&rep_id).ok_or("representation record is absent")?];
                mapped.push(output.mapped_representation(record, context, scale)?);
            }
            let record = &records[*ids.get(shape_id).ok_or("ProductDefinitionShape record is absent")?];
            plan.replacements.push(writer::replace(record, &[(2, writer::refs(&mapped))])?);
        }
        let mut edits = vec![(2, "0.".into()), (3, "0.".into()), (4, "0.".into()),
            (5, "1.".into()), (6, "0.".into()), (7, writer::real(unit)?)];
        if map.kind == IfcType::IfcMapConversionScaled {
            edits.extend([(8, "1.".into()), (9, "1.".into()), (10, "1.".into())]);
        }
        plan.replacements.push(writer::replace(map, &edits)?);
        plan.new_entities = output.finish();
        Ok(plan)
    };
    Ok(attempt().unwrap_or_else(|error| MapConversionNormalizationPlan {
        warnings: vec![format!("Map geometry normalization refused: {error}. No context geometry was changed.")],
        ..Default::default()
    }))
}

#[cfg(test)]
#[path = "step_map_transform_tests.rs"]
mod tests;
