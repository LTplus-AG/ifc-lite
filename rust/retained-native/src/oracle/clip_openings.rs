// SPDX-License-Identifier: MPL-2.0
//! Section-volume inclusion/exclusion for convex polygonal opening extrusions.
use super::*;
use crate::oracle::{clipping::convex_planes, math::{dot, transform, vector}};
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::prepass::{resolve_prepass,PrepassSpans,ResolveOptions};

pub(super) fn cutters(model: &Arc<SourceBundle>, sources: &AnalyticQuantitySources, product: u32)
    -> Result<Vec<Vec<([f64;3],f64)>>,String> {
    let mut scanner=EntityScanner::new(model.bytes());let mut spans=PrepassSpans::default();
    while let Some((id,name,start,end))=scanner.next_entity(){spans.stash(name,id,start,end);}
    let mut decoder=model.decoder();let prepass=resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
    let router=ifc_lite_geometry::GeometryRouter::with_scale(sources.extrusion_definitions.length_unit_scale);
    let mut result=Vec::new();
    for id in prepass.void_index.get(&product).into_iter().flatten() {
        if !router.opening_requires_subtraction(*id,&mut decoder){continue;}
        let instances=sources.extrusion_definitions.instances.get(id).ok_or("opening has no analytic extrusion")?;
        for instance in instances {
            if instance.source_modified{return Err("modified opening requires its own clip oracle".into());}
            if result.len()==8{return Err("clip-opening inclusion/exclusion budget".into());}
            let host=ExtrudedHost::from_sources(sources,instance).ok_or("opening extrusion unavailable")?;
            result.push(planes(&host).ok_or("opening must be a convex line-profile extrusion")?);
        }
    }
    Ok(result)
}
fn planes(host:&ExtrudedHost)->Option<Vec<([f64;3],f64)>> {
    if host.loops.len()!=1||!host.loops[0].0{return None;}
    let profile=convex_planes(&host.loops[0].1)?;
    let x=Vector3::from(vector(&host.frame,[1.,0.,0.]));
    let y=Vector3::from(vector(&host.frame,[0.,1.,0.]));
    let z=Vector3::from(host.direction);let origin=Vector3::from(transform(&host.frame,[0.;3]));
    let frame=Matrix4::from_columns(&[x.push(0.),y.push(0.),z.push(0.),origin.push(1.)]);
    let inverse=frame.try_inverse()?.transpose();
    let mut local:Vec<_>=profile.into_iter().map(|p|([-p.n[0],-p.n[1],0.],p.d)).collect();
    local.extend([([0.,0.,-1.],0.),([0.,0.,1.],host.depth)]);
    Some(local.into_iter().map(|(n,c)|{
        let n=inverse.transform_vector(&Vector3::from(n));let n=[n.x,n.y,n.z];
        (n,c+dot(n,[origin.x,origin.y,origin.z]))
    }).collect())
}
pub(super) fn net_volume(host:&ExtrudedHost,clips:&[Plane],cuts:&[Vec<([f64;3],f64)>])->Option<f64>{
    if cuts.len()>8{return None;}
    let base:Vec<_>=clips.iter().map(Plane::equation).collect();
    let mut volume=section_volume(host,&base)?;
    for mask in 1usize..(1<<cuts.len()) {
        let mut planes=base.clone();
        for (i,cut) in cuts.iter().enumerate(){if mask&(1<<i)!=0{planes.extend_from_slice(cut);}}
        let overlap=section_volume(host,&planes)?;
        volume+=if mask.count_ones().is_multiple_of(2){overlap}else{-overlap};
    }
    (volume.is_finite()&&volume>=0.).then_some(volume)
}
