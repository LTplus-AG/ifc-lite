// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Material association extraction.

use super::types::{EntityJob, MaterialAssociation};
use ifc_lite_core::EntityDecoder;
use rayon::prelude::*;
use std::sync::Arc;

/// One resolved material layer (intermediate, before element fan-out).
struct ResolvedLayer {
    kind: &'static str,
    member_count: u32,
    set_name: Option<String>,
    layer_index: u32,
    material_name: String,
    material_id: Option<u32>,
    member_name: Option<String>,
    material_category: Option<String>,
    fraction: Option<f64>,
    thickness: Option<f64>,
    is_ventilated: Option<bool>,
    category: Option<String>,
}

/// Resolve an `IfcMaterialLayer`'s referenced `IfcMaterial` name.
fn material_details_of(decoder: &mut EntityDecoder, material_id: u32) -> Option<(String, Option<String>)> {
    let mat = decoder.decode_by_id(material_id).ok()?;
    // An unnamed IfcMaterial still proves an association and may have a Category.
    Some((mat.get_string(0).unwrap_or("").to_string(), mat.get_string(2).map(str::to_string)))
}

/// Resolve a `RelatingMaterial` into a flat list of layers. Handles
/// `IfcMaterial`, `IfcMaterialLayerSet`, `IfcMaterialLayerSetUsage` (→ set),
/// `IfcMaterialList`, and `IfcMaterialConstituentSet`. `unit_scale` converts
/// layer thickness to metres.
fn resolve_material(decoder: &mut EntityDecoder, id: u32, unit_scale: f64) -> Vec<ResolvedLayer> {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return Vec::new();
    };
    let ty = entity.ifc_type.as_str().to_ascii_uppercase();

    match ty.as_str() {
        "IFCMATERIAL" => {
            vec![ResolvedLayer {
                kind: "IfcMaterial",
                member_count: 1,
                set_name: None,
                layer_index: 0,
                material_name: entity.get_string(0).unwrap_or("").to_string(),
                material_id: Some(id),
                member_name: None,
                material_category: entity.get_string(2).map(str::to_string),
                fraction: None,
                thickness: None,
                is_ventilated: None,
                category: entity.get_string(2).map(str::to_string),
            }]
        },
        "IFCMATERIALLAYERSETUSAGE" => {
            // ForLayerSet is attribute 0.
            match entity.get_ref(0) {
                Some(set_id) => resolve_material(decoder, set_id, unit_scale),
                None => Vec::new(),
            }
        }
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
                    // IfcMaterialLayer: Material(0), LayerThickness(1),
                    // IsVentilated(2), Name(3), Description(4), Category(5).
                    let (material_name, material_category) = layer
                        .get_ref(0)
                        .and_then(|mid| material_details_of(decoder, mid))
                        .unwrap_or_else(|| (String::new(), None));
                    let thickness = layer.get_float(1).map(|t| t * unit_scale);
                    let is_ventilated = super::read_logical(&layer, 2);
                    let category = layer.get_string(5).map(|s| s.to_string());
                    Some(ResolvedLayer {
                        kind: "IfcMaterialLayerSet",
                        member_count,
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
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
                    let (material_name, material_category) = material_details_of(decoder, mid)?;
                    Some(ResolvedLayer {
                        kind: "IfcMaterialList",
                        member_count,
                        set_name: None,
                        layer_index: i as u32,
                        material_name,
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
                    let (material_name, material_category) = constituent
                        .get_ref(2)
                        .and_then(|mid| material_details_of(decoder, mid))
                        .unwrap_or_else(|| (String::new(), None));
                    Some(ResolvedLayer {
                        kind: "IfcMaterialConstituentSet",
                        member_count,
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
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
        "IFCMATERIALPROFILESETUSAGE" => {
            // ForProfileSet is attribute 0.
            match entity.get_ref(0) {
                Some(set_id) => resolve_material(decoder, set_id, unit_scale),
                None => Vec::new(),
            }
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
                    let (material_name, material_category) = profile
                        .get_ref(2)
                        .and_then(|mid| material_details_of(decoder, mid))
                        .unwrap_or_else(|| (String::new(), None));
                    Some(ResolvedLayer {
                        kind: "IfcMaterialProfileSet",
                        member_count,
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
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

/// Extract material associations (`IfcRelAssociatesMaterial`).
pub(super) fn extract_materials(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
    unit_scale: f64,
) -> Vec<MaterialAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESMATERIAL")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting materials");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = super::related_object_ids(&rel);
            // RelatingMaterial is attribute 5.
            let Some(material_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let layers = resolve_material(&mut decoder, material_id, unit_scale);
            if layers.is_empty() {
                return Vec::new();
            }

            related
                .into_iter()
                .flat_map(|element_id| {
                    layers.iter().map(move |layer| MaterialAssociation {
                        element_id,
                        association_id: job.id,
                        definition_id: material_id,
                        member_count: layer.member_count,
                        kind: layer.kind.to_string(),
                        set_name: layer.set_name.clone(),
                        layer_index: layer.layer_index,
                        material_name: layer.material_name.clone(),
                        material_id: layer.material_id,
                        member_name: layer.member_name.clone(),
                        material_category: layer.material_category.clone(),
                        fraction: layer.fraction,
                        thickness: layer.thickness,
                        is_ventilated: layer.is_ventilated,
                        category: layer.category.clone(),
                    })
                })
                .collect()
        })
        .collect()
}
