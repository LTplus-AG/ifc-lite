// SPDX-License-Identifier: MPL-2.0
//! Source-only M6 oracle: inclusion–exclusion of triangulated boundary prisms.
//! No retained plan/cutter or output mesh supplies an expected volume.
use super::{bounded_partition::{pieces, extrusion_pieces, inside_distance, Plane}, bounded_source::{Clip,chain}, math::*, sections::{ExtrudedHost,section_volume}};
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::AnalyticQuantitySources;

pub struct Expectation {
    pub host_volume:f64,
    pub section_volume:Option<f64>,
    pub section_unavailable:Option<String>,
    pub curved:bool,
    clips:Vec<Clip>,
    basis:super::prism::Basis,
}
impl Expectation {
    /// Positive only strictly inside removed material, in world metres.
    /// An interior triangulation edge is not a material boundary.
    pub fn removed_clearance(&self,p:[f64;3])->f64 {
        let p=self.basis.point(p);
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
    let source_world=instance.world_from_source?;
    let basis=super::prism::Basis::new(&source_world)?;
    let scale=dot(vector(&source_world,[1.,0.,0.]),vector(&source_world,[1.,0.,0.])).sqrt();
    // Reuse the oracle's common host-relative basis. Build the source host
    // before adding survey placement, rather than subtracting rounded world
    // coordinates after profile/placement composition.
    let mut local=instance.clone();let mut world=IDENTITY;
    for i in 0..3 {world[5*i]=scale;}
    local.world_from_source=Some(world);
    let host=ExtrudedHost::from_sources(sources,&local)?;
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
            let mut local=i.clone();let original=i.world_from_source?;let mut relative=IDENTITY;
            for col in 0..3 {
                let mut axis=[0.;3];axis[col]=1.;let v=basis.vector(vector(&original,axis));
                relative[col*4..col*4+3].copy_from_slice(&v);
            }
            relative[12..15].copy_from_slice(&basis.point(transform(&original,[0.;3])));
            local.world_from_source=Some(relative);
            cuts.push(extrusion_pieces(&ExtrudedHost::from_sources(sources,&local)?)?);
        }
        Some(cuts)
    });
    let section=if solid_cuts {Err("solid Boolean operand outside section family".into())}
        else {extra.ok_or_else(||"opening source cannot be partitioned".to_string()).and_then(|extra|result_volume(&host,&clips,extra))};
    let (section_volume,section_unavailable)=match section {Ok(v)=>(Some(v),None),Err(reason)=>(None,Some(reason))};
    Some(Expectation{host_volume,section_volume,section_unavailable,curved,clips,basis})
}
fn result_volume(host:&ExtrudedHost,clips:&[Clip],extra:Vec<Vec<Vec<Plane>>>)->Result<f64,String> {
    if clips.len()>3{return Err("more than three halfspace clips".into());}
    let mut partitions=clips.iter().map(pieces).collect::<Option<Vec<_>>>().ok_or("curved or unpartitionable boundary")?;
    partitions.extend(extra);if partitions.len()>12{return Err("more than twelve source partitions".into());}
    let mut work=4096usize;let mut volume=0.;
    for mask in 0..1usize<<partitions.len() {
        let selected=partitions.iter().enumerate().filter(|(i,_)|mask&(1<<i)!=0).map(|(_,p)|p).collect::<Vec<_>>();
        // An opening may consist of two many-sided extrusions sharing a
        // physical cap and extending in opposite directions (FZK). Their
        // intersection has zero volume. Prove that from common source planes
        // before forming triangle tuples; do not raise the 4,096-work cap.
        if disjoint_common_planes(&selected) {continue;}
        let mut tuples=vec![Vec::<Plane>::new()];
        for partition in selected {
            if tuples.len().checked_mul(partition.len()).ok_or("section work overflow")?>work{return Err("section work cap exceeded".into());}
            tuples=tuples.into_iter().flat_map(|base|partition.iter().map(move |piece| {
                let mut planes=base.clone();planes.extend(piece);planes
            })).collect();
        }
        let sign=if mask.count_ones()%2==0{1.}else{-1.};
        for tuple in tuples {work=work.checked_sub(1).ok_or("section work cap exceeded")?;
            volume+=sign*section_volume(host,&tuple).ok_or_else(||format!("section integral unavailable: subset {mask}, {} planes, {} evaluations",tuple.len(),4096-work))?;}
    }
    volume.is_finite().then_some(volume).ok_or_else(||"nonfinite section sum".into())
}

/// Whether this direct body walk contains M6's source family. The comparison
/// harness uses this separately from `expected`, so a missing oracle cannot
/// quietly turn into an unverified published product.
pub fn applies(bytes:&[u8],product:u32)->bool {
    let bundle=SourceBundle::new(bytes.to_vec());let mut decoder=bundle.decoder();
    let Some((_,ids,_))=chain(product,&mut decoder) else{return false;};
    ids.into_iter().any(|id|decoder.decode_by_id(id).ok().is_some_and(|e|matches!(e.ifc_type,
        ifc_lite_core::IfcType::IfcPolygonalBoundedHalfSpace|ifc_lite_core::IfcType::IfcBoxedHalfSpace)))
}

fn disjoint_common_planes(partitions:&[&Vec<Vec<Plane>>])->bool {
    let common=partitions.iter().flat_map(|pieces| {
        pieces.first().into_iter().flat_map(|first|first.iter())
            .filter(|plane|pieces.iter().all(|piece|piece.contains(plane))).copied()
    }).collect::<Vec<_>>();
    common.iter().enumerate().any(|(i,(n,c))|common[i+1..].iter()
        .any(|(m,d)|*m==n.map(|v|-v)&&c+d<=0.))
}
