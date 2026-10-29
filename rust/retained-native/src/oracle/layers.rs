// SPDX-License-Identifier: MPL-2.0
//! Source-derived band integrals, independent of retained regions and meshes.
use super::{clipping::{Edge,convex_planes},math::*,prism::{self,Basis,Prism},sections::{ExtrudedHost,section_volume}};
use ifc_lite_processing::AnalyticQuantitySources;
#[path="layer_source.rs"]
mod source;
#[derive(Debug)]
pub struct LayerExpectation { pub volumes: Vec<f64>, pub opened_volume: f64, pub curved: bool }
pub fn expected(bytes: &[u8], sources: &AnalyticQuantitySources, id: u32) -> Option<LayerExpectation> {
    let bundle=ifc_lite_core::SourceBundle::new(bytes.to_vec()); let mut decoder=bundle.decoder();
    let usage=source::read(bytes,id,&mut decoder)?;
    let instances=sources.extrusion_definitions.instances.get(&id)?;
    let clips = super::clips::ClipOracle::new(&bundle, sources).expected(id).ok()?;
    if instances.len()!=1 || usage.thickness.len()<2 {return None;}
    if instances[0].source_modified && clips.is_none() {return None;}
    let clip = match &clips {
        Some(c) if c.parts.len() == 1 => Some(&c.parts[0]),
        Some(_) => return None,
        None => None,
    };
    let mut sum=0.; let boundaries:Vec<_>=usage.thickness.iter().take(usage.thickness.len()-1).map(|t|{sum+=t;sum}).collect();
    let (volumes,curved)=if let Some((center,radius,sigma))=usage.circle {
        let basis=Basis::new(&prism::profile_frame(sources,&instances[0])?)?;
        let center=basis.point(transform(&usage.frame,center));
        let mut hosts=prism::prisms(sources,id,&basis)?; if hosts.len()!=1 {return None;}
        let host=hosts.pop()?;
        let (inner,outer)=sector(&host,center)?;
        let mut cuts=Vec::new();
        for &id in &usage.openings { for p in prism::prisms(sources,id,&basis)? {
            if cuts.len()>=8 || p.loops.len()!=1 || !p.loops[0].0 {return None;}
            let planes=convex_planes(&p.loops[0].1)?; cuts.push((p,planes));
        } }
        let mut result=Vec::new();
        for k in 0..usage.thickness.len() {
            let previous=if k==0 {None} else {Some(radius-sigma*(usage.offset+usage.sense*boundaries[k-1]))};
            let next=boundaries.get(k).map(|c|radius-sigma*(usage.offset+usage.sense*c));
            let (a,b)=if sigma*usage.sense>0. {(next.unwrap_or(inner).max(inner),previous.unwrap_or(outer).min(outer))}
                else {(previous.unwrap_or(inner).max(inner),next.unwrap_or(outer).min(outer))};
            if a>=b {result.push(0.);continue;}
            let band=radial_band(&host,a,b)?;
            result.push(super::openings::cut_prisms_volume(vec![band],cuts.clone())?);
        }
        (result,true)
    } else {
        if !usage.openings.is_empty() {return None;}
        let host=ExtrudedHost::from_sources(sources,&instances[0])?;
        let curved=host.loops.iter().flat_map(|(_,edges)|edges)
            .any(|edge|matches!(edge,Edge::Arc{..}));
        let a=std::array::from_fn(|i|if i==usage.axis {1.} else {0.});
        let n=vector(&usage.frame,a).map(|v|v*usage.sense);
        let base=dot(n,transform(&usage.frame,a.map(|v|v*usage.offset)));
        let mut result=Vec::new();
        for k in 0..usage.thickness.len() {
            let mut planes=Vec::new();
            if k>0 {planes.push((n.map(|v|-v),-base-boundaries[k-1]));}
            if let Some(c)=boundaries.get(k) {planes.push((n,base+c));}
            result.push(if let Some(clip) = clip { clip.volume_with_planes(&planes)? }
                else { section_volume(&host,&planes)? });
        }
        (result,curved)
    };
    let opened_volume = if let Some(clips) = clips {
        if !usage.openings.is_empty() || usage.circle.is_some() { return None; }
        clips.section_volume()?
    } else { super::openings::prism_result_volume(sources,id,&usage.openings)? };
    Some(LayerExpectation{volumes,opened_volume,curved})
}
fn sector(host: &Prism,center:[f64;3]) -> Option<(f64,f64)> {
    if host.loops.len()!=1 || host.loops[0].1.len()!=4 {return None;}
    let arcs:Vec<_>=host.loops[0].1.iter().filter_map(|e|match e {
        Edge::Arc{c,u,v,..}=>Some((*c,*u,*v)), _=>None,
    }).collect();
    if arcs.len()!=2 {return None;}
    let mut radii=Vec::new();
    for (c,u,v) in arcs {
        let r=u[0].hypot(u[1]);
        if (c[0]-center[0]).hypot(c[1]-center[1])>1e-9 || (v[0].hypot(v[1])-r).abs()>1e-9 || r<=0. {return None;}
        radii.push(r);
    }
    Some((radii[0].min(radii[1]),radii[0].max(radii[1])))
}
fn radial_band(host: &Prism,inner:f64,outer:f64) -> Option<Prism> {
    let edges=&host.loops[0].1;
    let mut result=Vec::new();
    let arcs:Vec<_>=edges.iter().filter(|e|matches!(e,Edge::Arc{..})).collect();
    let radius=|e:&Edge|match e {Edge::Arc{u,..}=>u[0].hypot(u[1]),_=>0.};
    let minimum=arcs.iter().map(|e|radius(e)).fold(f64::INFINITY,f64::min);
    for edge in edges {
        if let Edge::Arc{c,u,v,a,sweep}=*edge {
            let r=radius(edge); let target=if r==minimum {inner} else {outer};
            result.push(Edge::Arc{c,u:u.map(|x|x*target/r),v:v.map(|x|x*target/r),a,sweep});
        }
    }
    if result.len()!=2 {return None;}
    let first=result.remove(0); let second=result.remove(0);
    let e1=Edge::Line(first.point(1.),second.point(0.)); let e2=Edge::Line(second.point(1.),first.point(0.));
    Some(Prism{loops:vec![(true,vec![first,e1,second,e2])],low:host.low,high:host.high,start:host.start})
}
