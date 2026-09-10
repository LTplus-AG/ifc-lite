// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{annotation_types::*, authored::{vector, refs}, canonical, validate_image_uri, AppearancePlan};
use ifc_lite_core::{AttributeValue as A, IfcType};
use ifc_lite_geometry::{ImageTextureRef, ResolvedTextureMap, TextureSource};
use rustc_hash::FxHashMap;
#[cfg(test)]
use super::source::Source;

pub(super) struct AuthoredProductPlan {
    pub plan: AppearancePlan,
    pub product_id:u32,
    pub geometry_item_id:u32,
    pub mesh:crate::types::mesh::MeshData,
    pub rtc_offset:[f64;3],
}
pub(super) fn plan_textured_product(bytes:&[u8], request:&AnnotationPlaneRequest, captured:Option<&super::captured_types::CapturedMesh>, repeat:[bool;2]) -> Result<AuthoredProductPlan,String> {
    let r=request;
    let f=&r.frame;
    let metadata=super::authored::Metadata {schema:&r.schema,source_revision:&r.source_revision,
        next_express_id:r.next_express_id,container_id:r.container_id,global_id:&r.global_id,
        containment_global_id:&r.containment_global_id,name:&r.name};
    super::authored::validate_metadata(&metadata)?;
    validate_image_uri(&r.image_uri)?;
    let super::authored::Authoring {mut author,mut source,placement,context_id,owner,scale,rtc_offset} =
        super::authored::prepare(bytes,&metadata,f,32)?;
    let size=f.size_metres.map(|v|v/scale);
    let vertices = captured.map_or_else(|| vec![[0.,0.,0.],[size[0],0.,0.],[size[0],size[1],0.],[0.,size[1],0.]], |m| m.positions.iter().map(|p| std::array::from_fn(|i| (p[i]-f.origin[i])/scale)).collect());
    let mut point_attributes=vec![A::List(vertices.into_iter().map(vector).collect())];
    if r.schema=="IFC4X3" { point_attributes.push(A::Null); } // TagList, IFC4X3 only.
    let points=author.add(IfcType::IfcCartesianPointList3D,point_attributes);
    let triangles:Vec<[i64;3]>=captured.map_or_else(|| vec![[1,2,3],[1,3,4]], |m| m.triangles.iter().map(|r|r.map(|i|i64::from(i)+1)).collect());
    let index_value=||A::List(triangles.iter().map(|row|A::List(row.iter().copied().map(A::Integer).collect())).collect());
    let item=author.add(IfcType::IfcTriangulatedFaceSet,vec![A::EntityRef(points),A::Null,A::Enum("F".into()),index_value(),A::Null]);
    let image=author.add(IfcType::IfcImageTexture,vec![A::Enum(if repeat[0] {"T"} else {"F"}.into()),A::Enum(if repeat[1] {"T"} else {"F"}.into()),A::Null,A::Null,A::Null,A::String(r.image_uri.clone())]);
    let uv=captured.map_or_else(|| vec![[0.,0.],[1.,0.],[1.,1.],[0.,1.]], |m|m.uvs.clone());
    let uv_triangles:Vec<[u32;3]>=captured.map_or_else(||vec![[1,2,3],[1,3,4]], |m|m.uv_triangles.iter().map(|r|r.map(|i|i+1)).collect());
    let vertices=author.add(IfcType::IfcTextureVertexList,vec![A::List(uv.iter().map(|v|A::List(v.iter().copied().map(A::Float).collect())).collect())]);
    author.add(IfcType::IfcIndexedTriangleTextureMap,vec![refs(&[image]),A::EntityRef(item),A::EntityRef(vertices),A::List(uv_triangles.iter().map(|r|A::List(r.iter().map(|i|A::Integer(i64::from(*i))).collect())).collect())]);
    let white=author.add(IfcType::IfcColourRgb,vec![A::Null,A::Float(1.),A::Float(1.),A::Float(1.)]);
    let shading=author.add(IfcType::IfcSurfaceStyleShading,vec![A::EntityRef(white),A::Float(0.)]);
    let texture=author.add(IfcType::IfcSurfaceStyleWithTextures,vec![refs(&[image])]);
    let style=author.add(IfcType::IfcSurfaceStyle,vec![A::String("Registered image".into()),A::Enum("BOTH".into()),refs(&[shading,texture])]);
    let styled=author.add(IfcType::IfcStyledItem,vec![A::EntityRef(item),refs(&[style]),A::Null]);
    let shape=author.add(IfcType::IfcShapeRepresentation,vec![A::EntityRef(context_id),A::String(if captured.is_some() {"Body"} else {"Annotation"}.into()),A::String("Tessellation".into()),refs(&[item])]);
    let product_shape=author.add(IfcType::IfcProductDefinitionShape,vec![A::Null,A::Null,refs(&[shape])]);
    let mut annotation_attributes=vec![A::String(r.global_id.clone()),owner.clone(),A::String(r.name.clone()),A::Null,
        A::String(if captured.is_some() {"IfcLite:CapturedSurface"} else {"IfcLite:RegisteredImage"}.into()),A::EntityRef(placement),A::EntityRef(product_shape)];
    if captured.is_some() { annotation_attributes.extend([A::Null,A::Enum("USERDEFINED".into())]); }
    else if r.schema=="IFC4X3" { annotation_attributes.push(A::Enum("USERDEFINED".into())); }
    let annotation=author.add(if captured.is_some() {IfcType::IfcBuildingElementProxy} else {IfcType::IfcAnnotation},annotation_attributes);
    author.add(IfcType::IfcRelContainedInSpatialStructure,vec![A::String(r.containment_global_id.clone()),owner,A::Null,A::Null,refs(&[annotation]),A::EntityRef(r.container_id)]);
    source.decoder.inject_shared_cache(&author.entities);
    let mut styles=crate::prepass::ResolvedPrepass::default();
    let (_,info)=crate::prepass::surface_style_from_styled_item(&author.entities[&styled],&mut source.decoder).ok_or("Generated style failed canonical resolution")?;
    styles.geometry_style_index.insert(item,info);
    let textures=FxHashMap::from_iter([(item,ResolvedTextureMap { texture_id:image,
        texture:TextureSource::Image(ImageTextureRef { url:r.image_uri.clone(),repeat_s:repeat[0],repeat_t:repeat[1] }),
        tex_coords:uv.iter().map(|v|v.map(|x|x as f32)).collect(),tex_coord_index:Some(uv_triangles) })]);
    let mut meshes=canonical::produce(&mut source,annotation,&textures,Some(&styles))?;
    if meshes.len()!=1 { return Err("Canonical annotation geometry did not produce exactly one textured plane".into()); }
    let mesh=meshes.remove(0);
    if mesh.indices.len()!=triangles.len()*3 || mesh.uvs.as_ref().is_none_or(|uv|uv.len()!=mesh.positions.len()/3*2)
        || mesh.positions.iter().chain(&mesh.normals).any(|v|!v.is_finite()) {
        return Err("Canonical authored geometry collapsed or lost its texture coordinates".into());
    }
    Ok(AuthoredProductPlan { plan:author.plan, product_id:annotation, geometry_item_id:item, mesh, rtc_offset })
}

/// Create one bounded textured annotation through the shared native product planner.
pub fn plan_annotation_plane(bytes: &[u8], request: &AnnotationPlaneRequest) -> Result<AnnotationPlanePlan,String> {
    let AuthoredProductPlan {plan,product_id,geometry_item_id,mesh,rtc_offset}=plan_textured_product(bytes,request,None,[false,false])?;
    let f=&request.frame;
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
    Ok(AnnotationPlanePlan { plan,annotation_id:product_id,geometry_item_id,mesh,
        coordinate_space:"ifc-z-up",rtc_offset,frame:request.frame.clone() })
}

#[cfg(test)]
#[path = "annotation_tests.rs"]
mod tests;
