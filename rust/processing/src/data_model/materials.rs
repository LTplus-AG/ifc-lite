// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Material association extraction.

use super::jobs::SplitDecoder;
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

/// Where one kind of material set keeps its members and what it reads off
/// each member (SERVER-39): the four set arms differed only in these indices,
/// so they are rows of one table walked by [`resolve_set`]. Attribute indices
/// are the schema's, as the former arms hard-coded them.
struct SetSpec {
    /// The `kind` the rows carry.
    kind: &'static str,
    /// The set's own Name attribute (`None`: the type has no name).
    name: Option<usize>,
    /// The attribute listing the members.
    members: usize,
    /// How a member is read.
    member: MemberSpec,
}

enum MemberSpec {
    /// The member is the `IfcMaterial` itself (`IfcMaterialList`).
    Material,
    /// The member is an entity of `ty` that references its material.
    Entity {
        ty: IfcType,
        material: usize,
        name: usize,
        category: usize,
        /// `IfcMaterialConstituent.Fraction`.
        fraction: Option<usize>,
        /// `IfcMaterialLayer.LayerThickness` (scaled) and `.IsVentilated`.
        layer: Option<(usize, usize)>,
    },
}

/// `IfcMaterialLayerSet`: MaterialLayers(0), LayerSetName(1). `IfcMaterialLayer`:
/// Material(0), LayerThickness(1), IsVentilated(2), Name(3), Description(4),
/// Category(5).
const LAYER_SET: SetSpec = SetSpec {
    kind: "IfcMaterialLayerSet",
    name: Some(1),
    members: 0,
    member: MemberSpec::Entity {
        ty: IfcType::IfcMaterialLayer,
        material: 0,
        name: 3,
        category: 5,
        fraction: None,
        layer: Some((1, 2)),
    },
};
/// `IfcMaterialList`: Materials(0).
const MATERIAL_LIST: SetSpec = SetSpec {
    kind: "IfcMaterialList",
    name: None,
    members: 0,
    member: MemberSpec::Material,
};
/// `IfcMaterialConstituentSet`: Name(0), Description(1), MaterialConstituents(2).
/// `IfcMaterialConstituent`: Name(0), Description(1), Material(2), Fraction(3),
/// Category(4).
const CONSTITUENT_SET: SetSpec = SetSpec {
    kind: "IfcMaterialConstituentSet",
    name: Some(0),
    members: 2,
    member: MemberSpec::Entity {
        ty: IfcType::IfcMaterialConstituent,
        material: 2,
        name: 0,
        category: 4,
        fraction: Some(3),
        layer: None,
    },
};
/// `IfcMaterialProfileSet`: Name(0), Description(1), MaterialProfiles(2).
/// `IfcMaterialProfile`: Name(0), Description(1), Material(2), Profile(3),
/// Priority(4), Category(5).
const PROFILE_SET: SetSpec = SetSpec {
    kind: "IfcMaterialProfileSet",
    name: Some(0),
    members: 2,
    member: MemberSpec::Entity {
        ty: IfcType::IfcMaterialProfile,
        material: 2,
        name: 0,
        category: 5,
        fraction: None,
        layer: None,
    },
};

/// Resolve the members of one material set, per its [`SetSpec`]. A member that
/// is not of the expected type, or whose material does not resolve, is skipped
/// (its index still counts).
fn resolve_set(
    decoder: &mut EntityDecoder,
    set: &DecodedEntity,
    spec: &SetSpec,
    unit_scale: f64,
) -> Vec<ResolvedLayer> {
    let set_name = spec.name.and_then(|i| set.get_string(i)).map(str::to_string);
    let member_count = set.get_list(spec.members).map_or(0, |l| l.len() as u32);
    let member_ids: Vec<u32> = set
        .get_list(spec.members)
        .map(|l| l.iter().filter_map(|v| v.as_entity_ref()).collect())
        .unwrap_or_default();
    member_ids
        .iter()
        .copied()
        .enumerate()
        .filter_map(|(i, member_id)| {
            let layer_index = i as u32;
            match &spec.member {
                MemberSpec::Material => {
                    let (material_name, material_category, material_name_present) =
                        material_details_of(decoder, member_id)?;
                    Some(ResolvedLayer {
                        kind: spec.kind,
                        member_count,
                        set_name: set_name.clone(),
                        layer_index,
                        material_name,
                        material_name_present,
                        material_id: Some(member_id),
                        member_name: None,
                        material_category,
                        fraction: None,
                        thickness: None,
                        is_ventilated: None,
                        category: None,
                    })
                }
                MemberSpec::Entity { ty, material, name, category, fraction, layer } => {
                    let member = decoder.decode_by_id(member_id).ok()?;
                    if !member.ifc_type.is_subtype_of(ty.clone()) {
                        return None;
                    }
                    let (material_name, material_category, material_name_present) =
                        match member.get_ref(*material) {
                            Some(mid) => material_details_of(decoder, mid)?,
                            None => (String::new(), None, false),
                        };
                    Some(ResolvedLayer {
                        kind: spec.kind,
                        member_count,
                        set_name: set_name.clone(),
                        layer_index,
                        material_name,
                        material_name_present,
                        material_id: member.get_ref(*material),
                        member_name: member.get_string(*name).map(str::to_string),
                        material_category,
                        fraction: (*fraction).and_then(|f| member.get_float(f)),
                        thickness: (*layer)
                            .and_then(|(t, _)| member.get_float(t))
                            .map(|t| t * unit_scale),
                        is_ventilated: (*layer).and_then(|(_, v)| super::read_logical(&member, v)),
                        category: member.get_string(*category).map(str::to_string),
                    })
                }
            }
        })
        .collect()
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
            resolve_set(decoder, entity, &LAYER_SET, unit_scale)
        }
        "IFCMATERIALLIST" => {
            resolve_set(decoder, entity, &MATERIAL_LIST, unit_scale)
        }
        "IFCMATERIALCONSTITUENTSET" => {
            resolve_set(decoder, entity, &CONSTITUENT_SET, unit_scale)
        }
        // Profiles carry no layer thickness, so thickness stays `None`.
        "IFCMATERIALPROFILESET" => {
            resolve_set(decoder, entity, &PROFILE_SET, unit_scale)
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
/// geometry), so 16 bytes per input byte binds only that product. A refusal
/// fails the whole response on the routes that carry geometry and the data
/// model together; the 121-fixture corpus peaks at 1.16% of this budget, and
/// this constant is the knob if a real file ever meets it.
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
    rel_jobs: &[&EntityJob],
    content: &[u8],
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
    units: &MaterialUnitContext,
) -> Result<Vec<MaterialAssociation>, String> {
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
        .map_init(
            || SplitDecoder::new(content, entity_index),
            |split, job| {
                let decoder = split.next_job();
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
                        let layers = resolve_material(decoder, &usages, material_id, scale);
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
            },
        )
        .collect::<Result<_, String>>()?;
    Ok(tables.into_iter().flatten().collect())
}
