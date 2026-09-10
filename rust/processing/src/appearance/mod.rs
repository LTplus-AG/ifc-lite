// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Opt-in appearance authoring over an effective IFC snapshot. No load-time
//! geometry changes. Plans are applied atomically by the host mutation editor.
mod budget;
mod evaluated;
mod evaluated_source;
mod evaluated_openings;
mod evaluated_replacement;
mod evaluated_precision;
mod evaluated_allocation;
mod annotation;
mod captured;
mod captured_types;
pub use captured::plan_captured_mesh;
pub use captured_types::{CapturedMesh, CapturedMeshRequest, CapturedMeshPlan};
mod annotation_types;
mod calibration;
mod registration;
mod registration_types;
pub use registration::register_scan_correspondences;
pub use registration_types::*;
mod canonical;
mod catalog;
mod context;
mod mapping;
mod page;
mod transfer;
mod transfer_types;
mod transfer_math;
mod transfer_budget;
mod transfer_surface;
mod transfer_target;
mod transfer_sampler;
pub use transfer::plan_mesh_transfer;
pub use transfer_types::*;
mod atlas_plan;
mod page_atlas;
mod page_raster;
mod page_types;
mod page_source;
mod page_material;
mod source;
mod texture_budget;
mod types;
use ifc_lite_core::IfcType;
use serde_json::{json, Value};
use source::{refs, Source};
use std::collections::BTreeSet;
pub use types::*;
pub use annotation::plan_annotation_plane;
pub use annotation_types::{AnnotationPlaneFrame, AnnotationPlaneRequest, AnnotationPlanePlan};
pub use page::plan_page_appearance;
pub use page_types::*;
pub use calibration::{calibrate_appearance_plane, CalibratedPlane, PlaneCalibrationRequest};
pub use catalog::{catalog_appearance, AppearanceCatalog, AppearanceCatalogProduct, AppearanceCatalogRequest, AppearanceCatalogType};

fn reference(id: u32) -> Value {
    Value::String(format!("#{id}"))
}
fn add(plan: &mut AppearancePlan, name: &str, attributes: Vec<Value>) -> u32 {
    let id = plan.next_available_express_id;
    plan.next_available_express_id += 1; // Capacity preflight below bounds the entire plan.
    plan.created.push(CreatedEntity {
        express_id: id,
        r#type: name.into(),
        attributes,
    });
    id
}

fn validate_image_uri(uri: &str) -> Result<(), String> {
    if uri.is_empty()
        || uri.len() > 240
        || !uri.is_ascii()
        || uri.starts_with('/')
        || uri.contains(['\\', ':', '?', '#', '%', '\''])
        || uri.chars().any(char::is_control)
        || uri
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Image URI must be a safe relative asset path".into());
    }
    Ok(())
}

/// `schema` must come from the host's validated parser; `nextExpressId` is its
/// reserved allocator watermark, strictly greater than every effective-source id.
/// Images must already have a model-owned, collision-free relative filename.
/// Returned UVs describe an UNSPLIT canonical item; fragment consumers must remap
/// source corners or refuse a mismatched vertex count, never truncate UV arrays.
pub fn plan_appearance(
    bytes: &[u8],
    request: &AppearanceRequest,
) -> Result<AppearancePlan, String> {
    if request.product_ids.is_empty() { return Err("Appearance scope must contain 1..10000 products".into()); }
    let mut source=Source::new(bytes)?;
    if request.representation_policy==RepresentationPolicy::EvaluatedOccurrence {
        let normalized=evaluated::prepare(bytes,request,&mut source)?;
        let plan=plan_with_source(bytes,normalized.request(),&mut source)?;
        return Ok(normalized.compose(plan,&source)?.0);
    }
    plan_with_source(bytes,request,&mut source)
}

fn plan_with_source(bytes:&[u8], request:&AppearanceRequest, source:&mut Source<'_>) -> Result<AppearancePlan,String> {
    if request.schema != "IFC4" && request.schema != "IFC4X3" {
        return Err("Appearance authoring requires IFC4 or IFC4X3".into());
    }
    if request.product_ids.len() > 10_000 {
        return Err("Appearance scope must contain 1..10000 products".into());
    }
    let uri = &request.image_uri;
    validate_image_uri(uri)?;
    mapping::validate(&request.mapping)?;
    texture_budget::preflight(source)?;
    let textures = ifc_lite_geometry::build_texture_index(bytes, &mut source.decoder);
    let max_id = source
        .types
        .last_key_value()
        .map(|(id, _)| *id)
        .unwrap_or(0);
    if request.next_express_id <= max_id {
        return Err("Stale allocator watermark overlaps effective IFC source".into());
    }
    let mut plan = AppearancePlan {
        source_revision: request.source_revision.clone(),
        next_express_id: request.next_express_id,
        next_available_express_id: request.next_express_id,
        ..Default::default()
    };
    let mut seen = BTreeSet::new();
    let mut budget = budget::PlanBudget::default();
    for &product in &request.product_ids {
        if !seen.insert(product) {
            continue;
        }
        let prepared = (|| {
            let ids = source.product_items(product)?;
            let mut items = Vec::new();
            for id in ids {
                // Existing non-surface styles remain on their StyledItem. An
                // old style definition is never mutated: other owners may use it.
                if let Some(styled) = source
                    .styled_items
                    .get(&id)
                    .and_then(|ids| ids.first())
                    .copied()
                {
                    let entity = source.entity(styled)?;
                    for style in refs(entity.get(1))? {
                        if !source
                            .types
                            .get(&style)
                            .is_some_and(|t| t.is_subtype_of(IfcType::IfcPresentationStyle))
                        {
                            return Err("Indirect or invalid presentation style assignment".into());
                        }
                    }
                }
                items.push(mapping::map_item(source, request, product, id, &mut budget)?);
            }
            canonical::align_source_corners(source, product, &mut items, &textures, request)?;
            Ok::<_, String>(items)
        })();
        // Resource refusal invalidates the whole command, never a partial success.
        if budget.exhausted { return Err(budget::BUDGET_ERROR.into()); }
        match prepared {
            Ok(items) => plan.items.extend(items),
            Err(reason) => plan.exclusions.push(Exclusion {
                product_id: product,
                reason,
            }),
        }
    }
    if plan.items.is_empty() {
        return Ok(plan);
    }
    let needed = plan
        .items
        .len()
        .checked_mul(3)
        .and_then(|n| n.checked_add(5))
        .ok_or("Appearance plan too large")?;
    if u64::from(plan.next_express_id) + needed as u64 >= u64::from(u32::MAX) {
        return Err("Appearance entity id capacity exceeded".into());
    }
    let image = add(
        &mut plan,
        "IfcImageTexture",
        vec![
            json!(if request.repeat_s { ".T." } else { ".F." }),
            json!(if request.repeat_t { ".T." } else { ".F." }),
            Value::Null,
            Value::Null,
            Value::Null,
            json!(uri),
        ],
    );
    let colour = add(
        &mut plan,
        "IfcColourRgb",
        vec![Value::Null, json!(1.0), json!(1.0), json!(1.0)],
    );
    let shading = add(
        &mut plan,
        "IfcSurfaceStyleShading",
        vec![reference(colour), json!(0.0)],
    );
    let texture_style = add(
        &mut plan,
        "IfcSurfaceStyleWithTextures",
        vec![json!([reference(image)])],
    );
    let surface_style = add(
        &mut plan,
        "IfcSurfaceStyle",
        vec![
            json!("Image appearance"),
            json!(".BOTH."),
            json!([reference(shading), reference(texture_style)]),
        ],
    );
    // Move item data out while accumulating mutation entities, avoiding copies
    // of large texture arrays solely to satisfy mutable plan ownership.
    let items = std::mem::take(&mut plan.items);
    for item in &items {
        let list = add(
            &mut plan,
            "IfcTextureVertexList",
            vec![json!(item.tex_coords)],
        );
        add(
            &mut plan,
            "IfcIndexedTriangleTextureMap",
            vec![
                json!([reference(image)]),
                reference(item.geometry_item_id),
                reference(list),
                json!(item.tex_coord_index),
            ],
        );
        if let Some(old_maps) = source.texture_maps.get(&item.geometry_item_id) {
            plan.removed.extend(old_maps);
        }
        if let Some(styled) = source
            .styled_items
            .get(&item.geometry_item_id)
            .and_then(|ids| ids.first())
            .copied()
        {
            let old = source.entity(styled)?;
            let mut styles: Vec<Value> = refs(old.get(1))?
                .into_iter()
                .filter(|id| source.types.get(id) != Some(&IfcType::IfcSurfaceStyle))
                .map(reference)
                .collect();
            styles.push(reference(surface_style));
            plan.edits.push(PositionalEdit {
                express_id: styled,
                index: 1,
                value: Value::Array(styles),
            });
        } else {
            add(
                &mut plan,
                "IfcStyledItem",
                vec![
                    reference(item.geometry_item_id),
                    json!([reference(surface_style)]),
                    Value::Null,
                ],
            );
        }
    }
    plan.items = items;
    plan.removed.sort_unstable();
    plan.removed.dedup();
    Ok(plan)
}

#[cfg(test)]
mod tests;
