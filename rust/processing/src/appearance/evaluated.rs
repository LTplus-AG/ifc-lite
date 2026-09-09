// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Private evaluated-occurrence normalization; publication is one appearance plan.
use super::{evaluated_source, source::Source, *};
use ifc_lite_core::{AttributeValue as A, DecodedEntity};
use rustc_hash::FxHashMap;
use std::sync::Arc;

struct Conversion {
    plan: AppearancePlan,
    binding: AppearanceConversion,
    styled_id: u32,
}
pub(super) struct Normalized {
    request: AppearanceRequest,
    conversions: Vec<Conversion>,
    exclusions: Vec<Exclusion>,
    start: u32,
}
fn list(ids: &[u32]) -> A { A::List(ids.iter().copied().map(A::EntityRef).collect()) }
// Authored, fixed-depth schema values only; never recursively walk source data.
fn wire(value: &A) -> Value {
    match value {
        A::EntityRef(id) => reference(*id), A::Null => Value::Null,
        A::String(s) => json!(s), A::Enum(s) => json!(format!(".{s}.")),
        A::Integer(n) => json!(n), A::Float(n) => json!(n),
        A::List(items) => json!(items.iter().map(wire).collect::<Vec<_>>()),
        _ => unreachable!("fixed authored values"),
    }
}
fn authored(plan: &mut AppearancePlan, entities: &mut FxHashMap<u32, Arc<DecodedEntity>>,
    ty: IfcType, attributes: Vec<A>) -> u32 {
    let id = add(plan,ty.name(),attributes.iter().map(wire).collect());
    entities.insert(id,Arc::new(DecodedEntity::new(id,ty,attributes))); id
}

pub(super) fn prepare(bytes: &[u8], request: &AppearanceRequest, source: &mut Source<'_>) -> Result<Normalized,String> {
    if !matches!(request.schema.as_str(),"IFC4"|"IFC4X3") || request.product_ids.is_empty()
        || request.product_ids.len()>10_000 || request.source_revision.len()>4096 {
        return Err("Evaluated appearance requires a bounded IFC4/IFC4X3 scope".into());
    }
    validate_image_uri(&request.image_uri)?;
    mapping::validate(&request.mapping)?;
    texture_budget::preflight(source)?;
    if request.next_express_id <= source.types.last_key_value().map_or(0,|(id,_)|*id) {
        return Err("Stale allocator watermark overlaps effective IFC source".into());
    }
    let mut styles = page_source::appearance(bytes,source);
    let textures = ifc_lite_geometry::build_texture_index(bytes,&mut source.decoder);
    let mut normalized = Normalized { request:request.clone(), conversions:Vec::new(), exclusions:Vec::new(), start:request.next_express_id };
    normalized.request.representation_policy=RepresentationPolicy::Preserve;
    normalized.request.product_ids.clear();
    let mut budget=budget::PlanBudget::default();
    let mut seen=BTreeSet::new();
    for &product_id in &request.product_ids {
        if !seen.insert(product_id) { continue; }
        if source.product_items(product_id).is_ok() {
            normalized.request.product_ids.push(product_id); continue;
        }
        let candidate=(|| {
            if styles.void_index.contains_key(&product_id) { return Err("Evaluated conversion of opening-bearing products is not supported yet".into()); }
            if matches!(request.mapping,Mapping::ExistingUv {..}) { return Err("Evaluated occurrence conversion requires a new planar or box mapping".into()); }
            let (product, body)=evaluated_source::body(source,product_id)?;
            let mut meshes=canonical::produce(source,product_id,&textures,Some(&styles))?;
            if meshes.len()!=1 { return Err("Evaluated appearance currently requires one unambiguous source surface".into()); }
            let mesh=meshes.remove(0);
            if mesh.texture.is_some() || mesh.uvs.is_some() { return Err("Evaluated conversion of textured source surfaces is not supported yet".into()); }
            let old_item=mesh.geometry_item_id.ok_or("Missing evaluated source item provenance")?;
            evaluated_source::validate_style_tree(source,&body,old_item)?;
            let surface=evaluated_source::surface_styles(source,old_item)?;
            if mesh.positions.len()%3!=0 || mesh.indices.len()%3!=0 || mesh.positions.is_empty()
                || mesh.indices.is_empty() || mesh.positions.iter().chain(&mesh.normals).any(|n|!n.is_finite())
                || mesh.indices.iter().any(|&i|i as usize>=mesh.positions.len()/3) {
                return Err("Canonical source geometry is invalid".into());
            }
            budget.reserve(mesh.positions.len()/3,mesh.indices.len()/3,0)?;
            let points=evaluated_source::local_points(source,&product,&mesh)?;
            Ok((body.clone(),points,mesh,old_item,surface,source::refs(body.get(3))?))
        })();
        let (mut body,points,mesh,old_item,surface,old_items)=match candidate {
            Ok(value)=>value,
            Err(reason)=> {
                if budget.exhausted { return Err(budget::BUDGET_ERROR.into()); }
                normalized.exclusions.push(Exclusion {product_id,reason}); continue;
            }
        };
        if u64::from(normalized.request.next_express_id)+3>=u64::from(u32::MAX) || source.types.len()+3>200_000 {
            return Err("Evaluated appearance entity capacity exceeded".into());
        }
        let mut plan=AppearancePlan {next_express_id:normalized.request.next_express_id,
            next_available_express_id:normalized.request.next_express_id,..Default::default()};
        let mut entities=FxHashMap::default();
        let rows=A::List(points.into_iter().map(|p|A::List(p.into_iter().map(A::Float).collect())).collect());
        let mut point_attributes=vec![rows];
        if request.schema=="IFC4X3" {point_attributes.push(A::Null);}
        let coordinates=authored(&mut plan,&mut entities,IfcType::IfcCartesianPointList3D,point_attributes);
        let indices=A::List(mesh.indices.chunks_exact(3).map(|tri|A::List(tri.iter().map(|&i|A::Integer(i64::from(i)+1)).collect())).collect());
        let item=authored(&mut plan,&mut entities,IfcType::IfcTriangulatedFaceSet,
            vec![A::EntityRef(coordinates),A::Null,A::Null,indices,A::Null]);
        let styled=authored(&mut plan,&mut entities,IfcType::IfcStyledItem,vec![A::EntityRef(item),list(&surface),A::Null]);
        Arc::make_mut(&mut body.attributes)[2]=A::String("Tessellation".into()); Arc::make_mut(&mut body.attributes)[3]=list(&[item]);
        plan.edits.extend([PositionalEdit {express_id:body.id,index:2,value:json!("Tessellation")},
            PositionalEdit {express_id:body.id,index:3,value:json!([reference(item)])}]);
        let body_id=body.id;
        entities.insert(body.id,Arc::new(body));
        source.decoder.inject_shared_cache(&entities);
        for entity in &plan.created { source.types.insert(entity.express_id,entities[&entity.express_id].ifc_type); }
        for old in old_items { if let Some(parents)=source.incoming.get_mut(&old) {parents.remove(&body_id);} }
        source.incoming.insert(coordinates,BTreeSet::from([item]));
        source.incoming.insert(item,BTreeSet::from([body_id,styled]));
        source.styled_items.insert(item,vec![styled]);
        let (_,style)=crate::prepass::surface_style_from_styled_item(&entities[&styled],&mut source.decoder)
            .ok_or("Converted surface style failed canonical resolution")?;
        styles.geometry_style_index.insert(item,style);
        let target=canonical::produce(source,product_id,&textures,Some(&styles))?;
        if target.len()!=1 { return Err("Evaluated replacement changed canonical submesh count".into()); }
        let target=&target[0];
        if mesh.indices.len()!=target.indices.len() || mesh.color!=target.color || mesh.material_name!=target.material_name {
            return Err("Evaluated replacement changed source appearance or triangle count".into());
        }
        for (&a,&b) in mesh.indices.iter().zip(&target.indices) {
            let before=canonical::corner_position(&mesh.positions,a)?;
            let after=canonical::corner_position(&target.positions,b)?;
            if (0..3).any(|axis|f64::from(before[axis])+mesh.origin[axis]!=f64::from(after[axis])+target.origin[axis]) {
                return Err("Evaluated replacement cannot preserve canonical triangle corners exactly".into());
            }
        }
        normalized.request.next_express_id=plan.next_available_express_id;
        normalized.request.product_ids.push(product_id);
        normalized.conversions.push(Conversion {plan,styled_id:styled,binding:AppearanceConversion {
            product_id,representation_id:body_id,source_geometry_item_id:old_item,geometry_item_id:item,source_indices:mesh.indices }});
    }
    Ok(normalized)
}
impl Normalized {
    pub(super) fn request(&self)->&AppearanceRequest {&self.request}
    pub(super) fn patch_styles(&self, source:&mut Source<'_>, styles:&mut crate::prepass::ResolvedPrepass)->Result<(),String> {
        for conversion in &self.conversions {
            let styled=source.entity(conversion.styled_id)?;
            let (_,style)=crate::prepass::surface_style_from_styled_item(&styled,&mut source.decoder).ok_or("Missing converted style")?;
            styles.geometry_style_index.insert(conversion.binding.geometry_item_id,style);
        }
        Ok(())
    }
    pub(super) fn compose(self,mut plan:AppearancePlan)->AppearancePlan {
        let accepted:BTreeSet<_>=plan.items.iter().map(|item|item.product_id).collect();
        for conversion in self.conversions {
            if accepted.contains(&conversion.binding.product_id) {
                plan.created.extend(conversion.plan.created); plan.edits.extend(conversion.plan.edits);
                plan.conversions.push(conversion.binding);
            }
        }
        // The common wire contract edits existing rows. Fold edits of private
        // normalization rows into their creation records before publication.
        let created:std::collections::BTreeMap<_,_>=plan.created.iter().enumerate().map(|(index,entity)|(entity.express_id,index)).collect();
        let edits=std::mem::take(&mut plan.edits);
        for edit in edits {
            if let Some(&index)=created.get(&edit.express_id) {
                plan.created[index].attributes[edit.index]=edit.value;
            } else { plan.edits.push(edit); }
        }
        plan.next_express_id=self.start;
        plan.exclusions.extend(self.exclusions); plan
    }
}

#[cfg(test)]
#[path = "evaluated_tests.rs"]
mod tests;
