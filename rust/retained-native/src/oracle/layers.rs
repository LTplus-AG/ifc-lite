// SPDX-License-Identifier: MPL-2.0
//! Source-derived band integrals, independent of retained regions and meshes.
use super::{clipping::{Edge,HalfPlane,convex_planes},math::*,prism::{self,Basis,Prism},section_net,sections::ExtrudedHost};
use ifc_lite_processing::AnalyticQuantitySources;
#[path="layer_source.rs"]
mod source;
#[derive(Debug)]
pub struct LayerExpectation { pub volumes: Vec<f64>, pub opened_volume: f64, pub curved: bool }
pub fn expected(bytes: &[u8], sources: &AnalyticQuantitySources, id: u32) -> Option<LayerExpectation> {
    let bundle=ifc_lite_core::SourceBundle::new(bytes.to_vec());
    expected_in(&bundle, &super::clips::ClipOracle::new(&bundle, sources), sources, id)
}
/// [`expected`] over the caller's model-wide source and clip oracle, built once per model.
pub fn expected_in(bundle: &std::sync::Arc<ifc_lite_core::SourceBundle>, clips: &super::clips::ClipOracle<'_>,
    sources: &AnalyticQuantitySources, id: u32) -> Option<LayerExpectation> {
    explain_in(bundle,clips,sources,id).ok()
}
/// [`expected_in`], naming why the source has no independent expectation (#7955).
pub fn explain_in(bundle: &std::sync::Arc<ifc_lite_core::SourceBundle>, clips_oracle: &super::clips::ClipOracle<'_>,
    sources: &AnalyticQuantitySources, id: u32) -> Result<LayerExpectation,&'static str> {
    let mut decoder=bundle.decoder();
    let usage=source::read(bundle.bytes(),id,&mut decoder).ok_or("usage_unreadable")?;
    let instances=sources.extrusion_definitions.instances.get(&id).ok_or("no_extrusion_instance")?;
    let clips = clips_oracle.expected(id).map_err(|_|"clip_oracle_err")?;
    if usage.thickness.len()<2 {return Err("single_layer");}
    // A chain with bounded halfspaces or solid operands: the M6 source partition.
    let chain=instances.iter().any(|i|i.source_modified).then(||super::bounded::chain_expected_in(bundle,sources,id)).flatten()
        .filter(|_|clips.as_ref().is_none_or(|c|c.parts.iter().any(|p|p.mixed)));
    if instances.len()!=1 && chain.is_none() {return Err("not_one_extrusion_instance");}
    if instances[0].source_modified && clips.is_none() && chain.is_none() {return Err("source_modified_no_clip");}
    let clip = match &clips {
        _ if chain.is_some() => None,
        Some(c) if c.parts.len() == 1 => Some(&c.parts[0]),
        Some(_) => return Err("multi_part_clip"),
        None => None,
    };
    let mut sum=0.; let boundaries:Vec<_>=usage.thickness.iter().take(usage.thickness.len()-1).map(|t|{sum+=t;sum}).collect();
    let (volumes,curved)=if let Some((center,radius,sigma))=usage.circle {
        if chain.is_some() {return Err("curved_chain");}
        let basis=prism::profile_frame(sources,&instances[0]).as_ref().and_then(Basis::new).ok_or("curved_no_basis")?;
        let center=basis.point(transform(&usage.frame,center));
        let mut hosts=prism::prisms(sources,id,&basis).ok_or("curved_no_host_prism")?; if hosts.len()!=1 {return Err("curved_not_one_host");}
        let host=hosts.pop().ok_or("curved_not_one_host")?;
        let (inner,outer)=sector(&host,center).ok_or("curved_not_a_sector")?;
        let cuts=opening_cuts(sources,&usage.openings,&basis).ok_or("l_opening_cuts")?;
        let mut result=Vec::new();
        for k in 0..usage.thickness.len() {
            let previous=if k==0 {None} else {Some(radius-sigma*(usage.offset+usage.sense*boundaries[k-1]))};
            let next=boundaries.get(k).map(|c|radius-sigma*(usage.offset+usage.sense*c));
            let (a,b)=if sigma*usage.sense>0. {(next.unwrap_or(inner).max(inner),previous.unwrap_or(outer).min(outer))}
                else {(previous.unwrap_or(inner).max(inner),next.unwrap_or(outer).min(outer))};
            if a>=b {result.push(0.);continue;}
            let band=super::layer_sector::radial_band(&host,a,b).ok_or("curved_band")?;
            result.push(super::openings::cut_prisms_volume(vec![band],cuts.clone()).ok_or("curved_band_integral")?);
        }
        (result,true)
    } else {
        let host=match &chain {
            Some(_)=>None,
            None=>Some(ExtrudedHost::from_sources(sources,&instances[0]).ok_or("host_not_extruded_source")?),
        };
        let curved=chain.as_ref().is_some_and(|e|e.curved)||host.iter().flat_map(|h|&h.loops).flat_map(|(_,edges)|edges)
            .any(|edge|matches!(edge,Edge::Arc{..}));
        let a=std::array::from_fn(|i|if i==usage.axis {1.} else {0.});
        let n=vector(&usage.frame,a).map(|v|v*usage.sense);
        let base=dot(n,transform(&usage.frame,a.map(|v|v*usage.offset)));
        // The chain's expectation already removes its product's openings.
        let (cuts,arcs)=if chain.is_some() {(Vec::new(),false)} else {clips_oracle.opening_cutters(id).map_err(|_|"opening_cutters")?};
        let mut result=Vec::new();
        for k in 0..usage.thickness.len() {
            let mut planes=Vec::new();
            if k>0 {planes.push((n.map(|v|-v),-base-boundaries[k-1]));}
            if let Some(c)=boundaries.get(k) {planes.push((n,base+c));}
            result.push(match (&chain,clip,&host) {
                (Some(e),_,_)=>e.volume_with_planes(&planes).ok_or("chain_band_integral")?,
                (_,Some(clip),_)=>clip.net_volume_with_planes(&planes,&cuts).ok_or("clip_band_integral")?,
                (_,_,Some(host))=>section_net::net_volume(host,&planes,&cuts).ok_or("band_integral")?,
                _=>return Err("host_not_extruded_source"),
            });
        }
        (result,curved||arcs)
    };
    let opened_volume = if let Some(e)=&chain {
        e.section_volume.ok_or("chain_section_volume")?
    } else if let Some(clips) = clips {
        if usage.circle.is_some() { return Err("curved_clip"); }
        clips.section_volume().ok_or("clip_section_volume")?
    } else if usage.circle.is_some() {
        super::openings::prism_result_volume(sources,id,&usage.openings).ok_or("o_prism_result_volume")?
    } else {
        let host=ExtrudedHost::from_sources(sources,&instances[0]).ok_or("host_not_extruded_source")?;
        section_net::net_volume(&host,&[],&clips_oracle.opening_cutters(id).map_err(|_|"opening_cutters")?.0).ok_or("net_integral")?
    };
    Ok(LayerExpectation{volumes,opened_volume,curved})
}
type OpeningCut = (Prism,Vec<HalfPlane>);
fn opening_cuts(sources:&AnalyticQuantitySources, ids:&[u32], basis:&Basis) -> Option<Vec<OpeningCut>> {
    let mut cuts=Vec::new();
    for &id in ids { for p in prism::prisms(sources,id,basis)? {
        if cuts.len()>=8 || p.loops.len()!=1 || !p.loops[0].0 {return None;}
        let planes=convex_planes(&p.loops[0].1)?; cuts.push((p,planes));
    } }
    Some(cuts)
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
