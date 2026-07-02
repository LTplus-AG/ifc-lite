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
    set_name: Option<String>,
    layer_index: u32,
    material_name: String,
    thickness: Option<f64>,
    is_ventilated: Option<bool>,
    category: Option<String>,
}

/// Resolve an `IfcMaterialLayer`'s referenced `IfcMaterial` name.
fn material_name_of(decoder: &mut EntityDecoder, material_id: u32) -> Option<String> {
    let mat = decoder.decode_by_id(material_id).ok()?;
    // IfcMaterial.Name is attribute 0.
    mat.get_string(0).map(|s| s.to_string())
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
        "IFCMATERIAL" => entity
            .get_string(0)
            .map(|name| {
                vec![ResolvedLayer {
                    set_name: None,
                    layer_index: 0,
                    material_name: name.to_string(),
                    thickness: None,
                    is_ventilated: None,
                    category: entity.get_string(2).map(|s| s.to_string()),
                }]
            })
            .unwrap_or_default(),
        "IFCMATERIALLAYERSETUSAGE" => {
            // ForLayerSet is attribute 0.
            match entity.get_ref(0) {
                Some(set_id) => resolve_material(decoder, set_id, unit_scale),
                None => Vec::new(),
            }
        }
        "IFCMATERIALLAYERSET" => {
            let set_name = entity.get_string(1).map(|s| s.to_string());
            let layer_ids: Vec<u32> = entity
                .get_list(0)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            layer_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, layer_id)| {
                    let layer = decoder.decode_by_id(layer_id).ok()?;
                    // IfcMaterialLayer: Material(0), LayerThickness(1),
                    // IsVentilated(2), Name(3), Description(4), Category(5).
                    let material_name = layer
                        .get_ref(0)
                        .and_then(|mid| material_name_of(decoder, mid))
                        .unwrap_or_else(|| "Unnamed".to_string());
                    let thickness = layer.get_float(1).map(|t| t * unit_scale);
                    let is_ventilated = super::read_logical(&layer, 2);
                    let category = layer.get_string(5).map(|s| s.to_string());
                    Some(ResolvedLayer {
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
                        thickness,
                        is_ventilated,
                        category,
                    })
                })
                .collect()
        }
        "IFCMATERIALLIST" => {
            let mat_ids: Vec<u32> = entity
                .get_list(0)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            mat_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, mid)| {
                    let material_name = material_name_of(decoder, mid)?;
                    Some(ResolvedLayer {
                        set_name: None,
                        layer_index: i as u32,
                        material_name,
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
            let constituent_ids: Vec<u32> = entity
                .get_list(2)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            constituent_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, cid)| {
                    let constituent = decoder.decode_by_id(cid).ok()?;
                    let material_name = constituent
                        .get_ref(2)
                        .and_then(|mid| material_name_of(decoder, mid))
                        .or_else(|| constituent.get_string(0).map(|s| s.to_string()))?;
                    Some(ResolvedLayer {
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
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
            let profile_ids: Vec<u32> = entity
                .get_list(2)
                .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
                .unwrap_or_default();
            profile_ids
                .into_iter()
                .enumerate()
                .filter_map(|(i, pid)| {
                    let profile = decoder.decode_by_id(pid).ok()?;
                    let material_name = profile
                        .get_ref(2)
                        .and_then(|mid| material_name_of(decoder, mid))
                        .or_else(|| profile.get_string(0).map(|s| s.to_string()))?;
                    Some(ResolvedLayer {
                        set_name: set_name.clone(),
                        layer_index: i as u32,
                        material_name,
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
                        set_name: layer.set_name.clone(),
                        layer_index: layer.layer_index,
                        material_name: layer.material_name.clone(),
                        thickness: layer.thickness,
                        is_ventilated: layer.is_ventilated,
                        category: layer.category.clone(),
                    })
                })
                .collect()
        })
        .collect()
}
