// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Material association extraction.

use super::material_units::MaterialUnitContext;
use super::material_usages::UsageTerminals;
use super::types::{EntityJob, MaterialAssociation};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rayon::prelude::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// One resolved material layer (intermediate, before element fan-out).
struct ResolvedLayer {
    kind: &'static str,
    member_count: u32,
    set_name: Option<String>,
    layer_index: u32,
    material_name: String,
    material_name_present: bool,
    material_id: Option<u32>,
    member_name: Option<String>,
    material_category: Option<String>,
    fraction: Option<f64>,
    thickness: Option<f64>,
    is_ventilated: Option<bool>,
    category: Option<String>,
}

/// Resolve an `IfcMaterialLayer`'s referenced `IfcMaterial` name.
fn material_details_of(decoder: &mut EntityDecoder, material_id: u32) -> Option<(String, Option<String>, bool)> {
    let mat = decoder.decode_by_id(material_id).ok()?;
    if !mat.ifc_type.is_subtype_of(IfcType::IfcMaterial) {
        return None;
    }
    // An unnamed IfcMaterial still proves an association and may have a Category.
    Some((mat.get_string(0).unwrap_or("").to_string(), mat.get_string(2).map(str::to_string), mat.get_string(0).is_some()))
}

/// Resolve a `RelatingMaterial` into a flat list of layers. Handles
/// `IfcMaterial`, `IfcMaterialLayerSet`, `IfcMaterialLayerSetUsage` (→ set),
/// `IfcMaterialProfileSet`, `IfcMaterialProfileSetUsage` (→ set),
/// `IfcMaterialList`, and `IfcMaterialConstituentSet`. `unit_scale` converts
/// layer thickness to metres.
///
/// Usages are followed iteratively, never by recursion (SERVER-5, #7673), and
/// memoised across associations in `usages` (see [`UsageTerminals`]). This
/// used to recurse into whatever a usage's attribute 0 named, so a usage
/// naming itself, or two usages naming each other, recursed until the stack
/// overflowed: SIGABRT, which takes every in-flight request on the server
/// down with it. Every acyclic input resolves exactly as it did before, and as
/// the TS twin does (`resolveMaterial` in
/// `packages/parser/src/material-definitions.ts`); a cycle resolves to nothing.
fn resolve_material(
    decoder: &mut EntityDecoder,
    usages: &UsageTerminals,
    id: u32,
    unit_scale: f64,
) -> Vec<ResolvedLayer> {
    let Some(definition_id) = usages.terminal(decoder, id, usage_target) else {
        return Vec::new();
    };
    let Ok(entity) = decoder.decode_by_id(definition_id) else {
        return Vec::new();
    };
    let ty = entity.ifc_type.as_str().to_ascii_uppercase();
    resolve_definition(decoder, &entity, &ty, definition_id, unit_scale)
}

/// `Some(attribute 0)` when `entity` is a material usage, `None` otherwise.
/// One arm per usage type (not an `|` pattern): the server/browser type
/// parity gate reads `"IFC..." =>` arms.
pub(super) fn usage_target(entity: &DecodedEntity) -> Option<Option<u32>> {
    match entity.ifc_type.as_str().to_ascii_uppercase().as_str() {
        // ForLayerSet is attribute 0.
        "IFCMATERIALLAYERSETUSAGE" => Some(entity.get_ref(0)),
        // ForProfileSet is attribute 0.
        "IFCMATERIALPROFILESETUSAGE" => Some(entity.get_ref(0)),
        _ => None,
    }
}

/// Resolve one material definition that is not a usage. `ty` is `entity`'s
/// upper-cased type name and `id` its express id. Never follows a usage, so it
/// cannot recurse.
fn resolve_definition(
    decoder: &mut EntityDecoder,
    entity: &DecodedEntity,
    ty: &str,
    id: u32,
    unit_scale: f64,
) -> Vec<ResolvedLayer> {
    match ty {
        "IFCMATERIAL" => {
            vec![ResolvedLayer {
                kind: "IfcMaterial",
                member_count: 1,
                set_name: None,
                layer_index: 0,
                material_name: entity.get_string(0).unwrap_or("").to_string(),
                material_name_present: entity.get_string(0).is_some(),
                material_id: Some(id),
                member_name: None,
                material_category: entity.get_string(2).map(str::to_string),
                fraction: None,
                thickness: None,
                is_ventilated: None,
                category: entity.get_string(2).map(str::to_string),
            }]
        },
        "IFCMATERIALLAYERSET" => {
            let set_name = entity.get_string(1).map(|s| s.to_string());
            let member_count = entity.get_list(0).map_or(0, |l| l.len() as u32);
            let layer_ids: Vec<u32> = entity
                .get_list(0)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            layer_ids
                .iter()
                .copied()
                .enumerate()
                .filter_map(|(i, layer_id)| {
                    let layer = decoder.decode_by_id(layer_id).ok()?;
                    if !layer.ifc_type.is_subtype_of(IfcType::IfcMaterialLayer) {
                        return None;
                    }
                    // IfcMaterialLayer: Material(0), LayerThickness(1),
                    // IsVentilated(2), Name(3), Description(4), Category(5).
                    let (material_name, material_category, material_name_present) = match layer.get_ref(0) {
                        Some(mid) => material_details_of(decoder, mid)?,
                        None => (String::new(), None, false),
                    };
                    let thickness = layer.get_float(1).map(|t| t * unit_scale);
                    let is_ventilated = super::read_logical(&layer, 2);
                    let category = layer.get_string(5).map(|s| s.to_string());
                    Some(ResolvedLayer {
                        kind: "IfcMaterialLayerSet",
                        member_count,
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        material_name_present,
                        material_id: layer.get_ref(0),
                        member_name: layer.get_string(3).map(str::to_string),
                        material_category,
                        fraction: None,
                        thickness,
                        is_ventilated,
                        category,
                    })
                })
                .collect()
        }
        "IFCMATERIALLIST" => {
            let member_count = entity.get_list(0).map_or(0, |l| l.len() as u32);
            let mat_ids: Vec<u32> = entity
                .get_list(0)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            mat_ids
                .iter()
                .copied()
                .enumerate()
                .filter_map(|(i, mid)| {
                    let (material_name, material_category, material_name_present) = material_details_of(decoder, mid)?;
                    Some(ResolvedLayer {
                        kind: "IfcMaterialList",
                        member_count,
                        set_name: None,
                        layer_index: i as u32,
                        material_name,
                        material_name_present,
                        material_id: Some(mid),
                        member_name: None,
                        material_category,
                        fraction: None,
                        thickness: None,
                        is_ventilated: None,
                        category: None,
                    })
                })
                .collect()
        }
        "IFCMATERIALCONSTITUENTSET" => {
            // IfcMaterialConstituentSet: Name(0), Description(1),
            // MaterialConstituents(2). Each IfcMaterialConstituent has
            // Name(0), Description(1), Material(2), Fraction(3), Category(4).
            let set_name = entity.get_string(0).map(|s| s.to_string());
            let member_count = entity.get_list(2).map_or(0, |l| l.len() as u32);
            let constituent_ids: Vec<u32> = entity
                .get_list(2)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            constituent_ids
                .iter()
                .copied()
                .enumerate()
                .filter_map(|(i, cid)| {
                    let constituent = decoder.decode_by_id(cid).ok()?;
                    if !constituent.ifc_type.is_subtype_of(IfcType::IfcMaterialConstituent) {
                        return None;
                    }
                    let (material_name, material_category, material_name_present) = match constituent.get_ref(2) {
                        Some(mid) => material_details_of(decoder, mid)?,
                        None => (String::new(), None, false),
                    };
                    Some(ResolvedLayer {
                        kind: "IfcMaterialConstituentSet",
                        member_count,
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        material_name_present,
                        material_id: constituent.get_ref(2),
                        member_name: constituent.get_string(0).map(str::to_string),
                        material_category,
                        fraction: constituent.get_float(3),
                        thickness: None,
                        is_ventilated: None,
                        category: constituent.get_string(4).map(|s| s.to_string()),
                    })
                })
                .collect()
        }
        "IFCMATERIALPROFILESET" => {
            // IfcMaterialProfileSet: Name(0), Description(1), MaterialProfiles(2).
            // Each IfcMaterialProfile: Name(0), Description(1), Material(2),
            // Profile(3), Priority(4), Category(5). Profiles carry no layer
            // thickness, so thickness stays `None`.
            let set_name = entity.get_string(0).map(|s| s.to_string());
            let member_count = entity.get_list(2).map_or(0, |l| l.len() as u32);
            let profile_ids: Vec<u32> = entity
                .get_list(2)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            profile_ids
                .iter()
                .copied()
                .enumerate()
                .filter_map(|(i, pid)| {
                    let profile = decoder.decode_by_id(pid).ok()?;
                    if !profile.ifc_type.is_subtype_of(IfcType::IfcMaterialProfile) {
                        return None;
                    }
                    let (material_name, material_category, material_name_present) = match profile.get_ref(2) {
                        Some(mid) => material_details_of(decoder, mid)?,
                        None => (String::new(), None, false),
                    };
                    Some(ResolvedLayer {
                        kind: "IfcMaterialProfileSet",
                        member_count,
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        material_name_present,
                        material_id: profile.get_ref(2),
                        member_name: profile.get_string(0).map(str::to_string),
                        material_category,
                        fraction: None,
                        thickness: None,
                        is_ventilated: None,
                        category: profile.get_string(5).map(|s| s.to_string()),
                    })
                })
                .collect()
        }
        _ => Vec::new(),
    }
}

/// Bytes of material rows the table may hold per input byte (floored at
/// [`MATERIAL_TABLE_MIN_BYTES`]). One `IfcRelAssociatesMaterial` emits a row
/// per related element per resolved layer, each cloning the layer's strings,
/// so the table grows as elements x layers while the input grows as elements
/// plus layers: a set listing one layer 1 000 times, related to 1 000 elements,
/// was 1 000 000 rows from 8 KB (#7675, SERVER-26). A real element costs the
/// file far more than its rows cost the table (its own record, placement and
/// geometry), so 16 bytes per input byte binds only that product.
const MATERIAL_TABLE_BYTES_PER_INPUT_BYTE: usize = 16;
const MATERIAL_TABLE_MIN_BYTES: usize = 16 << 20;

/// What one row built from `layer` holds: the row plus its owned strings.
fn row_bytes(layer: &ResolvedLayer) -> usize {
    let text = |s: &Option<String>| s.as_ref().map_or(0, String::len);
    std::mem::size_of::<MaterialAssociation>()
        + layer.kind.len()
        + layer.material_name.len()
        + text(&layer.set_name)
        + text(&layer.member_name)
        + text(&layer.material_category)
        + text(&layer.category)
}

/// Extract material associations (`IfcRelAssociatesMaterial`). `Err` names the
/// budget the table hit; nothing past it is built.
pub(super) fn extract_materials(
    jobs: &[EntityJob],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
    units: &MaterialUnitContext,
) -> Result<Vec<MaterialAssociation>, String> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESMATERIAL")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting materials");

    let usages = UsageTerminals::default();
    let budget = content.len().saturating_mul(MATERIAL_TABLE_BYTES_PER_INPUT_BYTE).max(MATERIAL_TABLE_MIN_BYTES);
    let used = AtomicUsize::new(0);
    let refusal = || {
        format!(
            "material associations exceed {budget} bytes for a {}-byte file (elements x layers)",
            content.len()
        )
    };
    let tables: Vec<Vec<MaterialAssociation>> = rel_jobs
        .par_iter()
        .map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content, entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Ok(Vec::new());
            };
            let related = super::related_object_ids(&rel);
            // RelatingMaterial is attribute 5.
            let Some(material_id) = rel.get_ref(5) else {
                return Ok(Vec::new());
            };
            let mut resolved_by_scale: HashMap<u64, (Vec<ResolvedLayer>, usize)> = HashMap::new();
            let mut rows = Vec::new();
            for element_id in related {
                let scale = units.scale_for(element_id);
                let (layers, bytes) = resolved_by_scale.entry(scale.to_bits()).or_insert_with(|| {
                    let layers = resolve_material(&mut decoder, &usages, material_id, scale);
                    let bytes = layers.iter().map(row_bytes).sum();
                    (layers, bytes)
                });
                if units.has_mixed_type_scales(element_id)
                    && layers.iter().any(|layer| layer.thickness.is_some())
                {
                    continue;
                }
                // Charged before the rows exist, across every job.
                if used.fetch_add(*bytes, Ordering::Relaxed).saturating_add(*bytes) > budget {
                    return Err(refusal());
                }
                rows.extend(layers.iter().map(|layer| MaterialAssociation {
                    element_id,
                    association_id: job.id,
                    definition_id: material_id,
                    member_count: layer.member_count,
                    kind: layer.kind.to_string(),
                    set_name: layer.set_name.clone(),
                    layer_index: layer.layer_index,
                    material_name: layer.material_name.clone(),
                    material_name_present: layer.material_name_present,
                    material_id: layer.material_id,
                    member_name: layer.member_name.clone(),
                    material_category: layer.material_category.clone(),
                    fraction: layer.fraction,
                    thickness: layer.thickness,
                    is_ventilated: layer.is_ventilated,
                    category: layer.category.clone(),
                }));
            }
            Ok(rows)
        })
        .collect::<Result<_, String>>()?;
    Ok(tables.into_iter().flatten().collect())
}
