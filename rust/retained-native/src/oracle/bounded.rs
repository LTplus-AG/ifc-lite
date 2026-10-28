// SPDX-License-Identifier: MPL-2.0
//! Source-only M6 oracle: inclusion–exclusion of triangulated boundary prisms.
//! No retained plan/cutter or output mesh supplies an expected volume.
use super::{bounded_partition::{pieces, extrusion_pieces, inside_distance, Plane}, bounded_source::{Clip,chain}, math::*, sections::{ExtrudedHost,section_volume}};
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::AnalyticQuantitySources;

pub struct Expectation {
    pub host_volume:f64,
    pub section_volume:Option<f64>,
    pub curved:bool,
    clips:Vec<Clip>,
    origin:[f64;3],
}
impl Expectation {
    /// Positive only strictly inside removed material, in world metres.
    /// An interior triangulation edge is not a material boundary.
    pub fn removed_clearance(&self,p:[f64;3])->f64 {
        let p=sub(p,self.origin);
        self.clips.iter().map(|clip| {
            let plane=clip.plane.1-dot(clip.plane.0,p);
            let lateral=clip.edges.as_ref().map_or(f64::INFINITY,|edges| {
                let scale=dot(vector(&clip.frame,[1.,0.,0.]),vector(&clip.frame,[1.,0.,0.])).sqrt();
                inside_distance(edges,clip.lateral_point(p))*scale
            });
            plane.min(lateral)
        }).fold(0.,f64::max)
    }
}
pub fn expected(bytes:&[u8],sources:&AnalyticQuantitySources,product:u32)->Option<Expectation> {
    let bundle=SourceBundle::new(bytes.to_vec());let mut decoder=bundle.decoder();
    let (host_id,ids,solid_cuts)=chain(product,&mut decoder)?;if ids.is_empty(){return None;}
    let instances=sources.extrusion_definitions.instances.get(&product)?;
    let instance=instances.iter().find(|i|i.source.solid_id==host_id)?;
    let mut host=ExtrudedHost::from_sources(sources,instance)?;
    let mut world=instance.world_from_source?;
    // Translate the source oracle before forming plane offsets. This retains
    // section accuracy for survey origins without changing the source geometry.
    let origin=transform(&world,[0.;3]);
    for i in 0..3 {world[12+i]-=origin[i];host.frame[12+i]-=origin[i];}
    let clips=ids.into_iter().map(|id|Clip::read(id,&world,&mut decoder)).collect::<Option<Vec<_>>>()?;
    let curved=clips.iter().any(|c|c.edges.as_ref().is_some_and(|e|e.iter().any(|s|matches!(s,super::clipping::Edge::Arc{..}))));
    let host_volume=section_volume(&host,&[])?;
    let mut scanner=ifc_lite_core::EntityScanner::new(bytes);let mut opening_ids=Vec::new();
    while let Some((id,name,_,_))=scanner.next_entity() {
        if name.eq_ignore_ascii_case("IFCRELVOIDSELEMENT") {
            let relation=decoder.decode_by_id(id).ok()?;
            if relation.get_ref(4)==Some(product) {opening_ids.push(relation.get_ref(5)?);}
        }
    }
    let extra=opening_ids.into_iter().try_fold(Vec::new(),|mut cuts,id| {
        let router=ifc_lite_geometry::GeometryRouter::with_scale(decoder.length_unit_scale());
        if !router.opening_requires_subtraction(id,&mut decoder){return Some(cuts);}
        for i in sources.extrusion_definitions.instances.get(&id)? {
            if i.source_modified{return None;}
            let mut opening=ExtrudedHost::from_sources(sources,i)?;
            for k in 0..3 {opening.frame[12+k]-=origin[k];}
            cuts.push(extrusion_pieces(&opening)?);
        }
        Some(cuts)
    });
    let section_volume=if solid_cuts {None}else{extra.and_then(|extra|result_volume(&host,&clips,extra))};
    Some(Expectation{host_volume,section_volume,curved,clips,origin})
}
fn result_volume(host:&ExtrudedHost,clips:&[Clip],extra:Vec<Vec<Vec<Plane>>>)->Option<f64> {
    if clips.len()>3{return None;}
    let mut partitions=clips.iter().map(pieces).collect::<Option<Vec<_>>>()?;
    partitions.extend(extra);if partitions.len()>12{return None;}
    let mut work=4096usize;let mut volume=0.;
    for mask in 0..1usize<<partitions.len() {
        let selected=partitions.iter().enumerate().filter(|(i,_)|mask&(1<<i)!=0).map(|(_,p)|p).collect::<Vec<_>>();
        let mut tuples=vec![Vec::<Plane>::new()];
        for partition in selected {
            if tuples.len().checked_mul(partition.len())?>work{return None;}
            tuples=tuples.into_iter().flat_map(|base|partition.iter().map(move |piece| {
                let mut planes=base.clone();planes.extend(piece);planes
            })).collect();
        }
        let sign=if mask.count_ones()%2==0{1.}else{-1.};
        for tuple in tuples {work=work.checked_sub(1)?;volume+=sign*section_volume(host,&tuple)?;}
    }
    volume.is_finite().then_some(volume)
}
