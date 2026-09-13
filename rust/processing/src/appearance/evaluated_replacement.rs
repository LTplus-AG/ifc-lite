// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Occurrence-owned replacement of a Body also retained by a shared type map.
use super::{evaluated::authored, source::{refs, Source}, *};
use ifc_lite_core::{AttributeValue as A, DecodedEntity};
use rustc_hash::FxHashMap;
use std::sync::Arc;

pub(super) fn layers(source: &mut Source<'_>, body: u32) -> Result<Vec<DecodedEntity>,String> {
    if !source.incoming.get(&body).is_some_and(|parents| parents.iter()
        .any(|id| source.types.get(id)==Some(&IfcType::IfcRepresentationMap))) {
        return Ok(Vec::new());
    }
    let mut result=Vec::new();
    for id in source.incoming.get(&body).cloned().unwrap_or_default() {
        if source.types.get(&id)!=Some(&IfcType::IfcPresentationLayerAssignment) {continue;}
        if result.len()==64 {return Err("Body layer associations exceed their budget".into());}
        let layer=source.entity(id)?;
        if layer.attributes.len()!=4 {return Err("Unsupported plain layer schema".into());}
        for index in [0,1,3] {
            match layer.get(index) {
                Some(A::Null)=>{},
                Some(A::String(label)) if label.len()<=4096
                    && !label.trim().starts_with(['#','.','$','*'])=>{},
                _=>return Err("Layer label cannot be preserved by the appearance wire writer".into()),
            }
        }
        result.push(layer);
    }
    Ok(result)
}

/// `items` is the complete new Items list: one face set, or the masked and
/// retained pair of a face-masked conversion.
pub(super) fn replace(
    source:&mut Source<'_>, product:u32, body:&mut DecodedEntity, items:&[u32],
    layers:Vec<DecodedEntity>, plan:&mut AppearancePlan,
    entities:&mut FxHashMap<u32,Arc<DecodedEntity>>,
)->Result<(),String> {
    let product=source.entity(product)?;
    let pds_id=product.get_ref(6).ok_or("Missing occurrence PDS")?;
    let old_body=body.id;
    let shared=source.incoming.get(&old_body).is_some_and(|parents|parents.iter()
        .any(|id|*id!=pds_id && source.types.get(id)!=Some(&IfcType::IfcPresentationLayerAssignment)));
    Arc::make_mut(&mut body.attributes)[2]=A::String("Tessellation".into());
    Arc::make_mut(&mut body.attributes)[3]=A::List(items.iter().copied().map(A::EntityRef).collect());
    if !shared {
        plan.edits.extend([PositionalEdit {express_id:old_body,index:2,value:json!("Tessellation")},
            PositionalEdit {express_id:old_body,index:3,value:json!(items.iter().copied().map(reference).collect::<Vec<_>>())}]);
        return Ok(());
    }
    let new_body=authored(plan,entities,IfcType::IfcShapeRepresentation,body.attributes.to_vec());
    body.id=new_body;
    let mut pds=source.entity(pds_id)?;
    let representation_ids=refs(pds.get(2))?;
    let replacement:Vec<_>=representation_ids.into_iter().map(|id|if id==old_body {new_body}else{id}).collect();
    Arc::make_mut(&mut pds.attributes)[2]=A::List(replacement.iter().copied().map(A::EntityRef).collect());
    plan.edits.push(PositionalEdit {express_id:pds_id,index:2,value:json!(replacement.iter().map(|&id|reference(id)).collect::<Vec<_>>())});
    entities.insert(pds_id,Arc::new(pds));
    source.incoming.get_mut(&old_body).ok_or("Missing original Body ownership")?.remove(&pds_id);
    let mut parents=BTreeSet::from([pds_id]);
    for layer in layers {
        let mut attributes=layer.attributes.to_vec();
        attributes[2]=A::List(vec![A::EntityRef(new_body)]);
        let id=authored(plan,entities,IfcType::IfcPresentationLayerAssignment,attributes);
        parents.insert(id);
    }
    source.incoming.insert(new_body,parents);
    Ok(())
}
