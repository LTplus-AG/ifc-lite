// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Keep composite private plans compatible with sequential host allocation.
use std::collections::BTreeMap;
use super::*;

pub(super) fn compact(plan: &mut AppearancePlan) -> Result<BTreeMap<u32,u32>,String> {
    plan.created.sort_unstable_by_key(|entity|entity.express_id);
    let ids:BTreeMap<_,_>=plan.created.iter().enumerate()
        .map(|(index,entity)|(entity.express_id,plan.next_express_id+index as u32)).collect();
    // The wire format uses strings for both references and labels. Visit only
    // EXPRESS reference slots in the entity types this authoring path generates.
    // A Name such as '#100001' is a literal, even when that ID is being compacted.
    let mut values=Vec::new();
    for entity in &mut plan.created {
        entity.express_id=ids[&entity.express_id];
        let slots:&[usize]=match entity.r#type.as_str() {
            "IfcTriangulatedFaceSet"|"IfcSurfaceStyleShading"|"IfcSurfaceStyleWithTextures"=>&[0],
            "IfcStyledItem"=>&[0,1], "IfcIndexedTriangleTextureMap"=>&[0,1,2],
            "IfcSurfaceStyle"=>&[2], "IfcImageTexture"=>&[3],
            "IfcSurfaceStyleRendering"=>&[0,2,3,4,5,6],
            "IfcCartesianPointList3D"|"IfcTextureVertexList"|"IfcColourRgb"=>&[],
            name=>return Err(format!("Unsupported generated appearance reference layout: {name}")),
        };
        values.extend(entity.attributes.iter_mut().enumerate().filter_map(|(index,value)|slots.contains(&index).then_some(value)));
    }
    for edit in &mut plan.edits {
        let body=plan.conversions.iter().any(|conversion|conversion.representation_id==edit.express_id);
        match (body,edit.index) {
            (true,3)|(false,1)=>values.push(&mut edit.value),
            (true,2)=>{},
            _=>return Err("Unsupported evaluated appearance reference edit".into()),
        }
    }
    // Only bounded generated plan arrays enter this iterative walk. Typed numeric
    // SELECT objects have no reference-bearing slots and are intentionally opaque.
    while let Some(value)=values.pop() {
        match value {
            Value::String(text)=> {
                if let Some(id)=text.strip_prefix('#').and_then(|id|id.parse::<u32>().ok()).and_then(|id|ids.get(&id)) {
                    *text=format!("#{id}");
                }
            },
            Value::Array(items)=>values.extend(items.iter_mut()),
            _=>{},
        }
    }
    for item in &mut plan.items { if let Some(&id)=ids.get(&item.geometry_item_id) {item.geometry_item_id=id;} }
    for item in &mut plan.conversions { if let Some(&id)=ids.get(&item.geometry_item_id) {item.geometry_item_id=id;} }
    plan.next_available_express_id=plan.next_express_id+plan.created.len() as u32;
    Ok(ids)
}
