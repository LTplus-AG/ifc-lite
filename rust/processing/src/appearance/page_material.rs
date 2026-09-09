// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{add, reference, source::Source, AppearancePlan};
use ifc_lite_core::{AttributeValue as A, IfcType};
use serde_json::{json, Value};

// Rendering SELECT slots are scalar: never recursively materialize a hostile
// nested list. Core's typed measure representation is [type-name, value].
fn scalar(value: &A) -> Result<Value, String> {
    match value {
        A::EntityRef(id) => Ok(reference(*id)),
        A::Null => Ok(Value::Null),
        A::Float(n) if n.is_finite() => Ok(json!(n)),
        A::Integer(n) => Ok(json!(n)),
        A::Enum(name) if name.len() <= 64 => Ok(json!(format!(".{name}."))),
        A::List(values) if values.len() == 2 => {
            let name = values[0].as_string().ok_or("Invalid rendering measure type")?;
            if !matches!(name, "IFCNORMALISEDRATIOMEASURE" | "IFCSPECULARROUGHNESS" | "IFCSPECULAREXPONENT") {
                return Err("Unsupported rendering SELECT measure".into());
            }
            let number = match &values[1] { A::Float(n) if n.is_finite() => *n, A::Integer(n) => *n as f64,
                _ => return Err("Invalid rendering measure value".into()) };
            Ok(json!({"typed": {"type": name, "value": number}}))
        }
        _ => Err("Unsupported rendering attribute; original material cannot be preserved".into()),
    }
}

pub(super) fn preserve(plan: &mut AppearancePlan, source: &mut Source<'_>, item: u32, target: u32, inherited_material: bool) -> Result<(), String> {
    let attached = source.styled_items.get(&item).cloned().unwrap_or_default();
    let mut resolved = None;
    for id in attached {
        let styled = source.entity(id)?;
        if let Some((style_id, _)) = crate::prepass::surface_style_from_styled_item(&styled, &mut source.decoder) {
            resolved = Some(style_id); break;
        }
    }
    let Some(original_id) = resolved else {
        if inherited_material { return Err("Page material metadata inherited through a material association is not yet supported".into()); }
        let mut pending = vec![item];
        let mut visited = std::collections::BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !visited.insert(id) { continue; }
            if visited.len() > 4096 { return Err("Page inherited style validation exceeds its work budget".into()); }
            if id != item && source.styled_items.contains_key(&id) {
                return Err("Page material metadata inherited through a representation is not yet supported".into());
            }
            for parent in source.incoming.get(&id).into_iter().flatten() {
                if matches!(source.types.get(parent), Some(IfcType::IfcShapeRepresentation | IfcType::IfcProductDefinitionShape | IfcType::IfcRepresentationMap | IfcType::IfcMappedItem)) {
                    pending.push(*parent);
                }
            }
        }
        return Ok(());
    };
    let original = source.entity(original_id)?;
    if original.get_string(0).is_some_and(|name| name.len() > 4096) {
        return Err("Source material name exceeds 4096-byte budget".into());
    }
    // Match the generic wire writer's reserved tokens after whitespace trim.
    // It cannot distinguish these free-text labels from null/derived/ref/enum
    // values when serializing a newly created style, so refuse losslessly.
    if original.get_string(0).is_some_and(|name| {
        let token=name.trim();
        matches!(token,"$"|"*")
            || token.strip_prefix('#').is_some_and(|id|!id.is_empty() && id.bytes().all(|c|c.is_ascii_digit()))
            || token.strip_prefix('.').and_then(|s|s.strip_suffix('.')).is_some_and(|s|!s.is_empty() && s.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'_'))
    }) {
        return Err("Page material name is a reserved appearance wire token and cannot be preserved".into());
    }
    let members = original.get_list(2).ok_or("Missing source surface style elements")?;
    if members.len() > 5 { return Err("Source surface style exceeds five-element schema limit".into()); }
    let mut extras = Vec::new();
    let mut rendering = None;
    for id in members.iter().filter_map(A::as_entity_ref) {
        let element = source.entity(id)?;
        match element.ifc_type {
            IfcType::IfcSurfaceStyleRendering if rendering.is_none() => rendering = Some(element),
            IfcType::IfcSurfaceStyleShading | IfcType::IfcSurfaceStyleWithTextures => {},
            IfcType::IfcSurfaceStyleLighting | IfcType::IfcSurfaceStyleRefraction | IfcType::IfcExternallyDefinedSurfaceStyle => extras.push(reference(id)),
            _ => return Err("Ambiguous source surface style elements cannot be preserved".into()),
        }
    }
    let Some(rendering) = rendering else {
        let target = plan.created.iter_mut().find(|e| e.express_id == target).ok_or("Missing atlas style")?;
        target.attributes[0] = original.get_string(0).map_or(Value::Null, |name| json!(name));
        target.attributes[1] = scalar(original.get(1).ok_or("Missing surface side")?)?;
        target.attributes[2].as_array_mut().ok_or("Invalid atlas style elements")?.extend(extras);
        return Ok(());
    };
    if rendering.attributes.len() != 9 { return Err("Invalid IfcSurfaceStyleRendering attribute count".into()); }
    let target_index = plan.created.iter().position(|e| e.express_id == target).ok_or("Missing atlas style")?;
    let leaves = plan.created[target_index].attributes[2].as_array().ok_or("Invalid atlas style elements")?.clone();
    let shading_ref = leaves.iter().find(|r| plan.created.iter().any(|e| reference(e.express_id) == **r && e.r#type == "IfcSurfaceStyleShading")).ok_or("Missing atlas shading")?.clone();
    let white = plan.created.iter().find(|e| reference(e.express_id) == shading_ref).unwrap().attributes[0].clone();
    let mut attributes: Vec<_> = rendering.attributes.iter().map(scalar).collect::<Result<_, _>>()?;
    // Original apparent albedo/alpha are already baked. Preserve the independent
    // rendering fields, avoiding a second diffuse-factor/transparency multiply.
    attributes[0] = white; attributes[1] = json!(0.);
    if rendering.get_ref(2).is_none() { attributes[2] = Value::Null; }
    let replacement = reference(add(plan, "IfcSurfaceStyleRendering", attributes));
    let mut elements: Vec<_> = leaves.into_iter().map(|v| if v == shading_ref { replacement.clone() } else { v }).collect();
    elements.extend(extras);
    plan.created[target_index].attributes[0] = original.get_string(0).map_or(Value::Null, |name| json!(name));
    plan.created[target_index].attributes[1] = scalar(original.get(1).ok_or("Missing surface side")?)?;
    plan.created[target_index].attributes[2] = json!(elements);
    Ok(())
}
