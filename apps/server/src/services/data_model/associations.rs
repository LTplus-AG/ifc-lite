// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Classification, material, and document association extraction.

use super::types::{
    ClassificationAssociation, DocumentAssociation, EntityJob, MaterialAssociation,
};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rayon::prelude::*;
use std::sync::Arc;

/// Read an `IfcLogical` / `IfcBoolean` attribute as a tri-state `Option<bool>`
/// (`.U.` / absent → `None`).
fn read_logical(entity: &DecodedEntity, index: usize) -> Option<bool> {
    let token = entity.get(index)?.as_enum()?;
    match token {
        "T" | "TRUE" | "true" => Some(true),
        "F" | "FALSE" | "false" => Some(false),
        _ => None,
    }
}

/// Collect the `RelatedObjects` (attribute 4) entity ids of an `IfcRelAssociates*`.
fn related_object_ids(rel: &DecodedEntity) -> Vec<u32> {
    rel.get_list(4)
        .map(|list| list.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default()
}

/// Resolve an `IfcClassificationReference` / `IfcClassification` into
/// `(identification, name, location, system_name)`. Walks `ReferencedSource`
/// up to the owning `IfcClassification` (bounded to avoid cycles).
fn resolve_classification(
    decoder: &mut EntityDecoder,
    id: u32,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return (None, None, None, None);
    };

    if entity
        .ifc_type
        .as_str()
        .eq_ignore_ascii_case("IFCCLASSIFICATION")
    {
        // Directly an IfcClassification: Name is attribute 3.
        return (
            None,
            None,
            None,
            entity.get_string(3).map(|s| s.to_string()),
        );
    }

    // IfcClassificationReference: Location(0), Identification(1), Name(2),
    // ReferencedSource(3).
    let location = entity.get_string(0).map(|s| s.to_string());
    let identification = entity.get_string(1).map(|s| s.to_string());
    let name = entity.get_string(2).map(|s| s.to_string());

    // Walk ReferencedSource up to the IfcClassification for the system name.
    let mut system_name = None;
    let mut source = entity.get_ref(3);
    let mut depth = 0;
    while let Some(src_id) = source {
        if depth >= 8 {
            break;
        }
        depth += 1;
        let Ok(src) = decoder.decode_by_id(src_id) else {
            break;
        };
        if src
            .ifc_type
            .as_str()
            .eq_ignore_ascii_case("IFCCLASSIFICATION")
        {
            system_name = src.get_string(3).map(|s| s.to_string());
            break;
        }
        // Another IfcClassificationReference — keep walking its ReferencedSource.
        source = src.get_ref(3);
    }

    (identification, name, location, system_name)
}

/// Extract classification associations (`IfcRelAssociatesClassification`).
pub(super) fn extract_classifications(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<ClassificationAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESCLASSIFICATION")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting classifications");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = related_object_ids(&rel);
            // RelatingClassification is attribute 5.
            let Some(class_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let (identification, name, location, system_name) =
                resolve_classification(&mut decoder, class_id);

            related
                .into_iter()
                .map(|element_id| ClassificationAssociation {
                    element_id,
                    system_name: system_name.clone(),
                    identification: identification.clone(),
                    name: name.clone(),
                    location: location.clone(),
                })
                .collect()
        })
        .collect()
}

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
                    let is_ventilated = read_logical(&layer, 2);
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
            let related = related_object_ids(&rel);
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

/// Resolve an `IfcDocumentReference` / `IfcDocumentInformation` into
/// `(identification, name, location, description)`.
fn resolve_document(
    decoder: &mut EntityDecoder,
    id: u32,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let Ok(entity) = decoder.decode_by_id(id) else {
        return (None, None, None, None);
    };
    let ty = entity.ifc_type.as_str().to_ascii_uppercase();

    if ty == "IFCDOCUMENTINFORMATION" {
        // Identification(0), Name(1), Description(2), Location(3).
        return (
            entity.get_string(0).map(|s| s.to_string()),
            entity.get_string(1).map(|s| s.to_string()),
            entity.get_string(3).map(|s| s.to_string()),
            entity.get_string(2).map(|s| s.to_string()),
        );
    }

    // IfcDocumentReference: Location(0), Identification(1), Name(2),
    // Description(3), ReferencedDocument(4).
    let mut location = entity.get_string(0).map(|s| s.to_string());
    let mut identification = entity.get_string(1).map(|s| s.to_string());
    let mut name = entity.get_string(2).map(|s| s.to_string());
    let mut description = entity.get_string(3).map(|s| s.to_string());

    // Backfill missing fields from the referenced IfcDocumentInformation.
    if let Some(info_id) = entity.get_ref(4) {
        if let Ok(info) = decoder.decode_by_id(info_id) {
            if info
                .ifc_type
                .as_str()
                .eq_ignore_ascii_case("IFCDOCUMENTINFORMATION")
            {
                identification =
                    identification.or_else(|| info.get_string(0).map(|s| s.to_string()));
                name = name.or_else(|| info.get_string(1).map(|s| s.to_string()));
                description = description.or_else(|| info.get_string(2).map(|s| s.to_string()));
                location = location.or_else(|| info.get_string(3).map(|s| s.to_string()));
            }
        }
    }

    (identification, name, location, description)
}

/// Extract document associations (`IfcRelAssociatesDocument`).
pub(super) fn extract_documents(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<DocumentAssociation> {
    let rel_jobs: Vec<_> = jobs
        .iter()
        .filter(|job| {
            job.type_name
                .eq_ignore_ascii_case("IFCRELASSOCIATESDOCUMENT")
        })
        .collect();

    tracing::debug!(count = rel_jobs.len(), "Extracting documents");

    rel_jobs
        .par_iter()
        .flat_map(|job| {
            let mut decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let Ok(rel) = decoder.decode_at(job.start, job.end) else {
                return Vec::new();
            };
            let related = related_object_ids(&rel);
            // RelatingDocument is attribute 5.
            let Some(doc_id) = rel.get_ref(5) else {
                return Vec::new();
            };
            let (identification, name, location, description) =
                resolve_document(&mut decoder, doc_id);

            related
                .into_iter()
                .map(|element_id| DocumentAssociation {
                    element_id,
                    identification: identification.clone(),
                    name: name.clone(),
                    location: location.clone(),
                    description: description.clone(),
                })
                .collect()
        })
        .collect()
}
