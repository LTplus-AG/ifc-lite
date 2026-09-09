// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{annotation_types::*, canonical, mapping, reference, source::Source, validate_image_uri, AppearancePlan, Mapping, MappingFrame};
use ifc_lite_core::{AttributeValue as A, DecodedEntity, IfcType};
use ifc_lite_geometry::{ImageTextureRef, ResolvedTextureMap, TextureSource};
use rustc_hash::FxHashMap;
use serde_json::{json, Value};
use std::sync::Arc;

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a.iter().zip(b).map(|(a,b)| a*b).sum() }
fn cross(a: [f64;3], b: [f64;3]) -> [f64;3] { [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]] }
fn vector(v: [f64;3]) -> A { A::List(v.into_iter().map(A::Float).collect()) }
fn refs(ids: &[u32]) -> A { A::List(ids.iter().copied().map(A::EntityRef).collect()) }
fn valid_guid(value: &str) -> bool {
    value.len()==22 && value.as_bytes()[0]<=b'3' && value.as_bytes()[0]>=b'0'
        && value.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'_' || c==b'$')
}
// Only our fixed authored schema rows reach this conversion: file-supplied
// aggregate values are never recursively cloned or reinterpreted here.
fn wire(value: &A) -> Value {
    match value {
        A::EntityRef(id) => reference(*id), A::Null => Value::Null,
        A::Derived => json!("*"), A::Enum(s) => json!(format!(".{s}.")),
        A::String(s) => json!(s), A::Integer(n) => json!(n), A::Float(n) => json!(n),
        A::List(v) => json!(v.iter().map(wire).collect::<Vec<_>>()),
    }
}
struct Author {
    plan: AppearancePlan,
    entities: FxHashMap<u32, Arc<DecodedEntity>>,
}
impl Author {
    fn add(&mut self, ty: IfcType, attributes: Vec<A>) -> u32 {
        let id = super::add(&mut self.plan, ty.name(), attributes.iter().map(wire).collect());
        self.entities.insert(id, Arc::new(DecodedEntity::new(id, ty, attributes))); id
    }
}

/// Create one bounded, textured IfcAnnotation in an explicitly chosen spatial
/// container. The source image is retained, not baked. Native production is the
/// same element funnel used by ordinary imports; no live model is mutated.
pub fn plan_annotation_plane(bytes: &[u8], request: &AnnotationPlaneRequest) -> Result<AnnotationPlanePlan, String> {
    let r=request;
    if !matches!(r.schema.as_str(), "IFC4"|"IFC4X3") || r.source_revision.len()>4096 || r.name.len()>1024
        || !valid_guid(&r.global_id) || !valid_guid(&r.containment_global_id) || r.global_id==r.containment_global_id {
        return Err("Annotation needs IFC4/IFC4X3, bounded metadata and distinct valid IFC GlobalIds".into());
    }
    validate_image_uri(&r.image_uri)?;
    let f=&r.frame;
    mapping::validate(&Mapping::Planar { frame: MappingFrame::World, origin:f.origin, axis_u:f.axis_u,
        axis_v:f.axis_v, metres_per_tile:f.size_metres })?;
    if (dot(f.axis_u,f.axis_u)-1.).abs()>1e-10 || (dot(f.axis_v,f.axis_v)-1.).abs()>1e-10 || dot(f.axis_u,f.axis_v).abs()>1e-10 {
        return Err("Annotation image frame must have orthonormal axes".into());
    }
    let mut source=Source::new(bytes)?;
    if source.types.len()+32>200_000 || r.next_express_id<=source.types.last_key_value().map_or(0,|(id,_)| *id)
        || r.next_express_id.checked_add(32).is_none() {
        return Err("Annotation allocator or entity budget is exhausted/stale".into());
    }
    let ids:Vec<_>=source.types.iter().filter(|(_,t)|t.is_subtype_of(IfcType::IfcRoot)).map(|(id,_)|*id).collect();
    for id in ids {
        let entity=source.entity(id)?;
        if entity.get_string(0).is_some_and(|guid|guid==r.global_id || guid==r.containment_global_id) {
            return Err("Annotation GlobalId already exists in the effective model".into());
        }
    }
    let container=source.entity(r.container_id)?;
    if !container.ifc_type.is_subtype_of(IfcType::IfcSpatialElement) {
        return Err("Choose an effective IfcSpatialElement as annotation container".into());
    }
    source.validate_world_placement(&container)?;
    let projects:Vec<_>=source.types.iter().filter(|(_,t)|**t==IfcType::IfcProject).map(|(id,_)|*id).collect();
    if projects.len()!=1 { return Err("Annotation creation needs one unambiguous IfcProject".into()); }
    let project=source.entity(projects[0])?;
    let mut contexts=Vec::new();
    for id in super::source::refs(project.get(7))? {
        let context=source.entity(id)?;
        if context.ifc_type==IfcType::IfcGeometricRepresentationContext && context.get(2).and_then(A::as_int)==Some(3) {
            contexts.push(id);
        }
    }
    if contexts.len()!=1 { return Err("Choose a model with one unambiguous root 3D representation context".into()); }
    let scale=source.decoder.length_unit_scale();
    if !scale.is_finite() || scale<=0. { return Err("Invalid model length unit".into()); }
    let context=source.context.as_ref().ok_or("Missing canonical load context")?;
    let rtc_offset=if context.meta.needs_shift { context.meta.rtc_offset.into() } else { [0.;3] };
    let transform=context.router().resolve_scaled_placement(&container,&mut source.decoder).map_err(|e|e.to_string())?;
    let columns:[[f64;3];3]=std::array::from_fn(|i|std::array::from_fn(|j|transform[i*4+j]));
    if transform.iter().any(|v|!v.is_finite()) || (0..3).any(|i| (0..3).any(|j|
        (dot(columns[i],columns[j])-if i==j {1.} else {0.}).abs()>1e-10)) || dot(cross(columns[0],columns[1]),columns[2])<0.999999 {
        return Err("Annotation container placement must be a finite right-handed rigid frame".into());
    }
    let inverse=|v:[f64;3]|columns.map(|c|dot(c,v));
    let origin=inverse(std::array::from_fn(|i|f.origin[i]-transform[12+i])).map(|v|v/scale);
    let u=inverse(f.axis_u); let normal=inverse(cross(f.axis_u,f.axis_v));
    let size=f.size_metres.map(|v|v/scale);
    if origin.iter().chain(&size).any(|v|!v.is_finite()) { return Err("Annotation placement exceeds numeric range".into()); }
    let mut author=Author { plan:AppearancePlan { source_revision:r.source_revision.clone(), next_express_id:r.next_express_id,
        next_available_express_id:r.next_express_id, ..Default::default() }, entities:FxHashMap::default() };
    let point=author.add(IfcType::IfcCartesianPoint,vec![vector(origin)]);
    let axis=author.add(IfcType::IfcDirection,vec![vector(normal)]);
    let direction=author.add(IfcType::IfcDirection,vec![vector(u)]);
    let axes=author.add(IfcType::IfcAxis2Placement3D,vec![A::EntityRef(point),A::EntityRef(axis),A::EntityRef(direction)]);
    let placement=author.add(IfcType::IfcLocalPlacement,vec![container.get_ref(5).map_or(A::Null,A::EntityRef),A::EntityRef(axes)]);
    let points=author.add(IfcType::IfcCartesianPointList3D,vec![A::List([[0.,0.,0.],[size[0],0.,0.],[size[0],size[1],0.],[0.,size[1],0.]].into_iter().map(vector).collect())]);
    let triangles=[[1,2,3],[1,3,4]];
    let index_value=||A::List(triangles.into_iter().map(|row|A::List(row.into_iter().map(A::Integer).collect())).collect());
    let item=author.add(IfcType::IfcTriangulatedFaceSet,vec![A::EntityRef(points),A::Null,A::Enum("F".into()),index_value(),A::Null]);
    let image=author.add(IfcType::IfcImageTexture,vec![A::Enum("F".into()),A::Enum("F".into()),A::Null,A::Null,A::Null,A::String(r.image_uri.clone())]);
    let uv=[[0.,0.],[1.,0.],[1.,1.],[0.,1.]];
    let vertices=author.add(IfcType::IfcTextureVertexList,vec![A::List(uv.into_iter().map(|v|A::List(v.into_iter().map(A::Float).collect())).collect())]);
    author.add(IfcType::IfcIndexedTriangleTextureMap,vec![refs(&[image]),A::EntityRef(item),A::EntityRef(vertices),index_value()]);
    let white=author.add(IfcType::IfcColourRgb,vec![A::Null,A::Float(1.),A::Float(1.),A::Float(1.)]);
    let shading=author.add(IfcType::IfcSurfaceStyleShading,vec![A::EntityRef(white),A::Float(0.)]);
    let texture=author.add(IfcType::IfcSurfaceStyleWithTextures,vec![refs(&[image])]);
    let style=author.add(IfcType::IfcSurfaceStyle,vec![A::String("Registered image".into()),A::Enum("BOTH".into()),refs(&[shading,texture])]);
    let styled=author.add(IfcType::IfcStyledItem,vec![A::EntityRef(item),refs(&[style]),A::Null]);
    let shape=author.add(IfcType::IfcShapeRepresentation,vec![A::EntityRef(contexts[0]),A::String("Annotation".into()),A::String("Tessellation".into()),refs(&[item])]);
    let product_shape=author.add(IfcType::IfcProductDefinitionShape,vec![A::Null,A::Null,refs(&[shape])]);
    let owner=project.get_ref(1).map_or(A::Null,A::EntityRef);
    let annotation=author.add(IfcType::IfcAnnotation,vec![A::String(r.global_id.clone()),owner.clone(),A::String(r.name.clone()),A::Null,
        A::String("IfcLite:RegisteredImage".into()),A::EntityRef(placement),A::EntityRef(product_shape)]);
    author.add(IfcType::IfcRelContainedInSpatialStructure,vec![A::String(r.containment_global_id.clone()),owner,A::Null,A::Null,refs(&[annotation]),A::EntityRef(r.container_id)]);
    source.decoder.inject_shared_cache(&author.entities);
    let mut styles=crate::prepass::ResolvedPrepass::default();
    let (_,info)=crate::prepass::surface_style_from_styled_item(&author.entities[&styled],&mut source.decoder).ok_or("Generated style failed canonical resolution")?;
    styles.geometry_style_index.insert(item,info);
    let textures=FxHashMap::from_iter([(item,ResolvedTextureMap { texture_id:image,
        texture:TextureSource::Image(ImageTextureRef { url:r.image_uri.clone(),repeat_s:false,repeat_t:false }),
        tex_coords:uv.map(|v|v.map(|x|x as f32)).to_vec(),tex_coord_index:Some(vec![[1,2,3],[1,3,4]]) })]);
    let mut meshes=canonical::produce(&mut source,annotation,&textures,Some(&styles))?;
    if meshes.len()!=1 { return Err("Canonical annotation geometry did not produce exactly one textured plane".into()); }
    let mesh=meshes.remove(0);
    if mesh.indices.len()!=6 || mesh.positions.len()!=12 || mesh.uvs.as_ref().is_none_or(|uv|uv.len()!=8)
        || mesh.positions.iter().chain(&mesh.normals).any(|v|!v.is_finite()) {
        return Err("Canonical annotation geometry collapsed or lost its texture coordinates".into());
    }
    let uv=mesh.uvs.as_ref().ok_or("Missing canonical annotation UVs")?;
    let tolerance=f.size_metres[0].min(f.size_metres[1])*1e-6;
    for (i,p) in mesh.positions.chunks_exact(3).enumerate() {
        let delta:[f64;3]=std::array::from_fn(|axis|f64::from(p[axis])+mesh.origin[axis]+rtc_offset[axis]-f.origin[axis]);
        let expected:[f64;3]=std::array::from_fn(|axis|f.axis_u[axis]*f64::from(uv[i*2])*f.size_metres[0]
            +f.axis_v[axis]*(1.-f64::from(uv[i*2+1]))*f.size_metres[1]);
        if delta.iter().zip(expected).any(|(actual,expected)|(actual-expected).abs()>tolerance) {
            return Err("Annotation frame loses precision in canonical geometry; move closer to the model origin or increase its size".into());
        }
    }
    Ok(AnnotationPlanePlan { plan:author.plan,annotation_id:annotation,geometry_item_id:item,mesh,
        coordinate_space:"ifc-z-up",rtc_offset,frame:r.frame.clone() })
}

#[cfg(test)]
#[path = "annotation_tests.rs"]
mod tests;
