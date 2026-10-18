// SPDX-License-Identifier: MPL-2.0

use std::collections::{BTreeMap, HashSet};
use ifc_lite_geometry::analytic::AnalyticStatus;
use crate::{extract_analytic_quantity_sources, SweptDiskInstance};
use super::{AuthoredConstruction, AuthoredDefinition, AuthoredEvaluationContract,
    AuthoredGeometryPlan, AuthoredProductPlan, AuthoredRecipe, EvaluationRequirement};

/// Lower the existing bounded analytic source view into explicit construction
/// requests. Does not perform geometry evaluation, CSG, opening subtraction,
/// repair, unit conversion or tessellation. `ids = Some(empty)` returns no work.
/// Other geometry families and unlowered operation DAGs remain explicit product
/// requirements; they are never interpreted as empty successful geometry.
pub fn plan_authored_geometry(content: &[u8], ids: Option<&HashSet<u32>>) -> AuthoredGeometryPlan {
    let views = extract_analytic_quantity_sources(content, ids);
    let inventory = super::inventory::inventory(content, ids);
    let mut products = BTreeMap::new();
    for id in inventory.products.iter().copied().chain(ids.into_iter().flatten().copied()) {
        products.entry(id).or_insert_with(|| AuthoredProductPlan {
            product_id: id, occurrences: Vec::new(),
            requirements: vec![EvaluationRequirement::RepresentationCoverageUnverified],
        });
    }
    for (id, product) in &mut products {
        if !inventory.products.contains(id) {
            product.requirements.push(EvaluationRequirement::RequestedProductUnavailable);
        }
        if !inventory.opening_relationships_verified {
            product.requirements.push(EvaluationRequirement::OpeningRelationshipsUnverified);
        }
        if let Some(links) = inventory.openings.get(id) {
            product.requirements.extend(links.iter().map(|&(relationship_id, opening_id)|
                EvaluationRequirement::ExternalOpening { relationship_id, opening_id }));
        }
    }
    let mut plan = AuthoredGeometryPlan {
        model_sha256: views.extrusion_definitions.model_sha256.clone(),
        schema: views.extrusion_definitions.schema.clone(),
        source_units: "ifc_file_length_units", world_units: "m", up_axis: "Z",
        length_unit_scale: views.extrusion_definitions.length_unit_scale,
        definitions: Vec::new(), recipes: Vec::new(), products,
        diagnostics: inventory.diagnostics,
    };
    // The three analytic views share diagnostics; deduplicate without hiding
    // distinct failures. Stable order makes reports reproducible.
    let mut seen_diagnostics: HashSet<_> = plan.diagnostics.iter().cloned().collect();
    for message in views.swept_disk_descriptions.diagnostics.iter()
        .chain(&views.swept_disk_definitions.diagnostics)
        .chain(&views.extrusion_definitions.diagnostics) {
        if seen_diagnostics.insert(message.clone()) { plan.diagnostics.push(message.clone()); }
    }
    for source in views.extrusion_definitions.sources {
        plan.definitions.push(AuthoredDefinition::Extrusion(Box::new(source)));
    }
    for source in views.swept_disk_definitions.sources {
        plan.definitions.push(AuthoredDefinition::SweptDisk(source));
    }
    let definitions: BTreeMap<_, _> = plan.definitions.iter().map(|source| {
        let (construction, status) = match source {
            AuthoredDefinition::Extrusion(source) => (AuthoredConstruction::Extrusion, &source.source.status),
            AuthoredDefinition::SweptDisk(source) => (AuthoredConstruction::SweptDisk, &source.status),
        };
        (source.key().clone(), (construction, status.clone()))
    }).collect();
    for instance in views.extrusion_definitions.instances.into_values().flatten()
        .chain(views.swept_disk_definitions.instances.into_values().flatten()) {
        add_occurrence(&mut plan, instance, &definitions);
    }
    for product in plan.products.values_mut() {
        if product.occurrences.is_empty() {
            product.requirements.push(EvaluationRequirement::NoSupportedAuthoredSources);
        }
    }
    plan
}

fn add_occurrence(
    plan: &mut AuthoredGeometryPlan, instance: SweptDiskInstance,
    definitions: &BTreeMap<crate::AnalyticSourceKey, (AuthoredConstruction, AnalyticStatus)>,
) {
    let product = plan.products.entry(instance.product_id).or_insert_with(|| AuthoredProductPlan {
        product_id: instance.product_id, occurrences: Vec::new(),
        requirements: vec![EvaluationRequirement::RepresentationCoverageUnverified],
    });
    if instance.source_modified {
        product.requirements.push(EvaluationRequirement::EnclosingBoolean { solid_id: instance.solid_id });
    }
    let definition = definitions.get(&instance.source);
    let reason = match (definition, &instance.status, instance.world_from_source) {
        (Some((_, AnalyticStatus::Unsupported(reason))), _, _) => Some(reason.clone()),
        (_, AnalyticStatus::Unsupported(reason), _) => Some(reason.clone()),
        (None, _, _) => Some("authored source definition unavailable".into()),
        (_, _, None) => Some("authored occurrence placement unavailable".into()),
        _ => None,
    };
    if let Some(reason) = reason {
        product.requirements.push(EvaluationRequirement::UnsupportedSource { solid_id: instance.solid_id, reason });
    } else if let (Some((construction, _)), Some(world_from_source)) = (definition, instance.world_from_source) {
        plan.recipes.push(AuthoredRecipe { source: instance.source.clone(), product_id: instance.product_id,
            source_ordinal: instance.ordinal, construction: *construction,
            contract: AuthoredEvaluationContract::AuthoredSourceOnly, world_from_source });
    }
    product.occurrences.push(instance);
}
