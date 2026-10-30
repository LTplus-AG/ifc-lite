// SPDX-License-Identifier: MPL-2.0
//! Source-only M6 oracle: inclusion–exclusion of triangulated boundary prisms.
//! No retained plan/cutter or output mesh supplies an expected volume.
use super::{bounded_partition::{pieces, extrusion_pieces, inside_distance, Plane}, bounded_source::{Clip,chain}, math::*, sections::{ExtrudedHost,section_volume}};
use ifc_lite_core::{SourceBundle,slot};
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
    let chain=chain(product,&mut decoder)?;if chain.clips.is_empty(){return None;}
    let instances=sources.extrusion_definitions.instances.get(&product)?;
    let instance=instances.iter().find(|i|i.source.solid_id==chain.host)?;
    let source_world=instance.world_from_source?;
    let basis=super::prism::Basis::new(&source_world)?;
    let relative=|frame:&[f64;16]| {
        let mut local=IDENTITY;
        for col in 0..3 {
            let mut axis=[0.;3];axis[col]=1.;
            local[col*4..col*4+3].copy_from_slice(&basis.vector(vector(frame,axis)));
        }
        local[12..15].copy_from_slice(&basis.point(transform(frame,[0.;3])));
        local
    };
    // Reuse the oracle's common host-relative basis. Build the source host
    // before adding survey placement, rather than subtracting rounded world
    // coordinates after profile/placement composition.
    let mut local=instance.clone();
    let world=relative(&source_world);
    local.world_from_source=Some(world);
    let host=ExtrudedHost::from_sources(sources,&local)?;
    // A clip can be outside an inner map on FirstOperand. Bring each authored
    // mapping frame into the same host-relative metric basis, not just the ids.
    let inverse=ifc_lite_geometry::Matrix4::from_column_slice(&chain.host_frame).try_inverse()?;
    let inverse:[f64;16]=inverse.as_slice().try_into().ok()?;
    let product_world=multiply(&source_world,&inverse);
    let clips=chain.clips.into_iter().map(|(id,frame)| {
        Clip::read(id,&relative(&multiply(&product_world,&frame)),&mut decoder)
    }).collect::<Option<Vec<_>>>()?;
    let curved=clips.iter().any(|c|c.edges.as_ref().is_some_and(|e|e.iter().any(|s|matches!(s,super::clipping::Edge::Arc{..}))));
    let host_volume=section_volume(&host,&[])?;
    let mut scanner=ifc_lite_core::EntityScanner::new(bytes);let mut opening_ids=Vec::new();
    while let Some((id,name,_,_))=scanner.next_entity() {
        if name.eq_ignore_ascii_case("IFCRELVOIDSELEMENT") {
            let relation=decoder.decode_by_id(id).ok()?;
            if relation.get_ref(slot::IfcRelVoidsElement::RELATING_BUILDING_ELEMENT.index())==Some(product) {opening_ids.push(relation.get_ref(slot::IfcRelVoidsElement::RELATED_OPENING_ELEMENT.index())?);}
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
    let section=if chain.solid_cuts {Err("solid Boolean operand outside section family".into())}
        else {extra.ok_or_else(||"opening source cannot be partitioned".to_string()).and_then(|extra|result_volume(&host,&clips,extra))};
    let (section_volume,section_unavailable)=match section {Ok(v)=>(Some(v),None),Err(reason)=>(None,Some(reason))};
    Some(Expectation{host_volume,section_volume,section_unavailable,curved,clips,basis})
}
fn result_volume(host:&ExtrudedHost,clips:&[Clip],extra:Vec<Vec<Vec<Plane>>>)->Result<f64,String> {
    if clips.len()==1 && extra.is_empty() && clips[0].edges.as_ref()
        .is_some_and(|edges|edges.iter().any(|e|matches!(e,super::clipping::Edge::Arc{..}))) {
        return super::bounded_curved::result_volume(host,&clips[0]).ok_or("curved source integral unavailable".into());
    }
    let mut partitions=clips.iter().map(pieces).collect::<Option<Vec<_>>>().ok_or("curved or unpartitionable boundary")?;
    partitions.extend(extra);
    let mut work=4096usize;
    // Exporter chains often include distant roof patches. Prove each piece's
    // intersection with the authored host is empty before forming IE tuples.
    // The proof spends the same section budget and never looks at output mesh.
    let long_chain=clips.len()>3;
    if long_chain {
        let mut active=Vec::new();
        for partition in partitions {
            let mut pieces=Vec::new();
            for piece in partition {
                work=work.checked_sub(1).ok_or("section work cap exceeded")?;
                if section_volume(host,&piece).ok_or("source intersection unavailable")?>0. {pieces.push(piece);}
            }
            if !pieces.is_empty(){active.push(pieces);}
        }
        partitions=active;
    }
    if partitions.len()>12{return Err(format!("more than twelve active source partitions: {}",partitions.len()));}
    let disjoint=if long_chain {disjoint_pairs(host,&partitions,&mut work)?}else{Vec::new()};
    work=work.checked_sub(1).ok_or("section work cap exceeded")?;
    let host_volume=section_volume(host,&[]).ok_or("host section unavailable")?;
    let mut volume=0.;
    for mask in 0..1usize<<partitions.len() {
        if disjoint.iter().any(|pair|mask&pair==*pair){continue;}
        let selected=partitions.iter().enumerate().filter(|(i,_)|mask&(1<<i)!=0).map(|(_,p)|p).collect::<Vec<_>>();
        // An opening may consist of two many-sided extrusions sharing a
        // physical cap and extending in opposite directions (FZK). Their
        // intersection has zero volume. Prove that from common source planes
        // before forming triangle tuples; do not raise the 4,096-work cap.
        if disjoint_common_planes(&selected) {continue;}
        if !long_chain {
            let mut tuples=vec![Vec::<Plane>::new()];
            for partition in selected {
                if tuples.len().checked_mul(partition.len()).ok_or("section work overflow")?>work{return Err("section work cap exceeded".into());}
                tuples=tuples.into_iter().flat_map(|base|partition.iter().map(move |piece| {
                    let mut planes=base.clone();planes.extend(piece);planes
                })).collect();
            }
            let sign=if mask.count_ones()%2==0{1.}else{-1.};
            for tuple in tuples {
                work=work.checked_sub(1).ok_or("section work cap exceeded")?;
                volume+=sign*section_volume(host,&tuple).ok_or("section integral unavailable")?;
            }
            continue;
        }
        let mut tuples=vec![(Vec::<Plane>::new(),host_volume)];
        for partition in selected {
            let mut next=Vec::new();
            for (base,_) in tuples {for piece in partition {
                work=work.checked_sub(1).ok_or("section work cap exceeded")?;
                let mut planes=base.clone();planes.extend(piece);
                let v=section_volume(host,&planes).ok_or("section integral unavailable")?;
                if v>0. {next.push((planes,v));}
            }}
            tuples=next;
            if tuples.is_empty(){break;}
        }
        let sign=if mask.count_ones()%2==0{1.}else{-1.};
        volume+=sign*tuples.into_iter().map(|(_,v)|v).sum::<f64>();
    }
    volume.is_finite().then_some(volume).ok_or_else(||"nonfinite section sum".into())
}

/// Whether this direct body walk contains M6's source family. The comparison
/// harness uses this separately from `expected`, so a missing oracle cannot
/// quietly turn into an unverified published product.
pub fn applies(bytes:&[u8],product:u32)->bool {
    let bundle=SourceBundle::new(bytes.to_vec());let mut decoder=bundle.decoder();
    super::bounded_source::contains_bounded(product,&mut decoder).unwrap_or(true)
}

fn disjoint_common_planes(partitions:&[&Vec<Vec<Plane>>])->bool {
    let common=partitions.iter().flat_map(|pieces| {
        pieces.first().into_iter().flat_map(|first|first.iter())
            .filter(|plane|pieces.iter().all(|piece|piece.contains(plane))).copied()
    }).collect::<Vec<_>>();
    common.iter().enumerate().any(|(i,(n,c))|common[i+1..].iter()
        .any(|(m,d)|*m==n.map(|v|-v)&&c+d<=0.))
}

/// A zero host intersection for every piece pair proves the two removed
/// regions disjoint. Cache that proof so all supersets skip without spending
/// an exponential number of section evaluations on the same empty region.
fn disjoint_pairs(host:&ExtrudedHost,partitions:&[Vec<Vec<Plane>>],work:&mut usize)->Result<Vec<usize>,String> {
    let mut pairs=Vec::new();
    for i in 0..partitions.len() {for j in i+1..partitions.len() {
        let mut overlap=false;
        'pieces: for a in &partitions[i] {for b in &partitions[j] {
            *work=work.checked_sub(1).ok_or("section work cap exceeded")?;
            let mut planes=a.clone();planes.extend(b);
            if section_volume(host,&planes).ok_or("pairwise section unavailable")?>0. {
                overlap=true;break 'pieces;
            }
        }}
        if !overlap {pairs.push((1<<i)|(1<<j));}
    }}
    Ok(pairs)
}

/// Explain why a required source oracle cannot model the authored body.
pub fn unmodelled_reason(bytes:&[u8],product:u32)->Option<String> {
    let bundle=SourceBundle::new(bytes.to_vec());let mut decoder=bundle.decoder();
    if let Err(reason)=super::bounded_source::contains_bounded(product,&mut decoder){return Some(reason);}
    super::bounded_source::unmodelled_reason(product,&mut decoder)
}
