// SPDX-License-Identifier: MPL-2.0
//! Source-only M6 oracle: inclusion–exclusion of triangulated boundary prisms.
//! No retained plan/cutter or output mesh supplies an expected volume.
use super::{bounded_partition::{pieces, inside_distance, Plane}, bounded_source::{Clip,chain}, clipping::Edge, math::*, section_net::{self, ConvexCut}, sections::{ExtrudedHost,section_volume}};
use ifc_lite_core::{SourceBundle,slot};
use std::sync::Arc;
use ifc_lite_processing::AnalyticQuantitySources;

pub struct Expectation {
    pub host_volume:f64,
    pub section_volume:Option<f64>,
    pub section_unavailable:Option<String>,
    pub curved:bool,
    clips:Vec<Clip>,
    basis:super::prism::Basis,
    host:ExtrudedHost,
    /// The removal as source constraints and cutters, when the source partitions.
    removal:Result<(Vec<Plane>,Vec<Vec<ConvexCut>>),String>,
}
impl Expectation {
    /// This result's volume inside further world halfspaces: one material band (M4).
    pub(super) fn volume_with_planes(&self,world:&[Plane])->Option<f64> {
        let (kept,cuts)=self.removal.as_ref().ok()?;
        let mut planes=kept.clone();
        planes.extend(world.iter().map(|&(n,c)|{let local=self.basis.vector(n);(local,c-dot(n,self.basis.origin()))}));
        section_net::net_volume(&self.host,&planes,cuts)
    }
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
    expected_in(&SourceBundle::new(bytes.to_vec()),sources,product)
}
/// [`expected`] over the caller's model-wide source, so a model is indexed once, not per product.
pub fn expected_in(bundle:&Arc<SourceBundle>,sources:&AnalyticQuantitySources,product:u32)->Option<Expectation> {
    chain_expected_in(bundle,sources,product).filter(|e|!e.clips.is_empty())
}
/// [`expected_in`] for any Difference chain, also one of solid operands only.
pub(super) fn chain_expected_in(bundle:&Arc<SourceBundle>,sources:&AnalyticQuantitySources,product:u32)->Option<Expectation> {
    let bytes=bundle.bytes();let mut decoder=bundle.decoder();
    let chain=chain(product,&mut decoder)?;
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
    // An arc in the host profile is chordal once tessellated, like one in a boundary.
    let curved=host.loops.iter().flat_map(|(_,edges)|edges).any(|e|matches!(e,super::clipping::Edge::Arc{..}))
        || clips.iter().any(|c|c.edges.as_ref().is_some_and(|e|e.iter().any(|s|matches!(s,super::clipping::Edge::Arc{..}))));
    let host_volume=section_volume(&host,&[])?;
    let mut scanner=ifc_lite_core::EntityScanner::new(bytes);let mut opening_ids=Vec::new();
    while let Some((id,name,_,_))=scanner.next_entity() {
        if name.eq_ignore_ascii_case("IFCRELVOIDSELEMENT") {
            let relation=decoder.decode_by_id(id).ok()?;
            if relation.get_ref(slot::IfcRelVoidsElement::RELATING_BUILDING_ELEMENT.index())==Some(product) {opening_ids.push(relation.get_ref(slot::IfcRelVoidsElement::RELATED_OPENING_ELEMENT.index())?);}
        }
    }
    let cut_arcs=std::cell::Cell::new(false);
    let local_cut=|i:&ifc_lite_processing::ExtrusionInstance| -> Option<Vec<ConvexCut>> {
        let mut local=i.clone();
        local.world_from_source=Some(relative(&i.world_from_source?));
        let (cuts,arcs)=section_net::extrusion_cutters(&ExtrudedHost::from_sources(sources,&local)?)?;
        cut_arcs.set(cut_arcs.get()||arcs);
        Some(cuts)
    };
    let mut removal:Result<Vec<Vec<ConvexCut>>,String>=opening_ids.into_iter().try_fold(Vec::new(),|mut cuts,id| {
        let router=ifc_lite_geometry::GeometryRouter::with_scale(decoder.length_unit_scale());
        if !router.opening_requires_subtraction(id,&mut decoder){return Some(cuts);}
        for i in sources.extrusion_definitions.instances.get(&id)? {
            if i.source_modified{return None;}
            cuts.push(local_cut(i)?);
        }
        Some(cuts)
    }).ok_or_else(||"opening source cannot be partitioned".to_string());
    if let Ok(cuts)=&mut removal {
        for id in &chain.solids {
            let operand=instances.iter().find(|i|i.source.solid_id==*id).and_then(local_cut);
            match operand {Some(pieces)=>cuts.push(pieces),None=>{removal=Err("solid Boolean operand outside section family".into());break;}}
        }
    }
    let curved_clip=clips.iter().any(|c|c.edges.as_ref().is_some_and(|e|e.iter().any(|s|matches!(s,Edge::Arc{..}))));
    let exchanged=removal.as_ref().is_ok_and(|cuts|cuts.is_empty()&&clips.len()==1&&curved_clip);
    let removal=removal.and_then(|cuts|split_removal(&clips,cuts));
    let section=if exchanged {super::bounded_curved::result_volume(&host,&clips[0]).ok_or("curved source integral unavailable".to_string())}
        else {removal.clone().and_then(|(kept,cuts)|section_net::net_volume(&host,&kept,&cuts).ok_or("section integral unavailable".to_string()))};
    let (section_volume,section_unavailable)=match section {Ok(v)=>(Some(v),None),Err(reason)=>(None,Some(reason))};
    let curved=curved||cut_arcs.get();
    Some(Expectation{host_volume,section_volume,section_unavailable,curved,clips,basis,host,removal})
}
/// A plain halfspace keeps its other side, so it costs no inclusion-exclusion; a bounded
/// one and each other solid remove their partition pieces.
fn split_removal(clips:&[Clip],mut cuts:Vec<Vec<ConvexCut>>)->Result<(Vec<Plane>,Vec<Vec<ConvexCut>>),String> {
    let mut kept=Vec::new();
    for clip in clips {
        if clip.edges.is_none() {kept.push((clip.plane.0.map(|v|-v),-clip.plane.1));}
        else {cuts.push(pieces(clip).ok_or("curved or unpartitionable boundary")?);}
    }
    Ok((kept,cuts))
}

/// Whether this direct body walk contains M6's source family. The comparison
/// harness uses this separately from `expected`, so a missing oracle cannot
/// quietly turn into an unverified published product.
pub fn applies(bytes:&[u8],product:u32)->bool {
    applies_in(&SourceBundle::new(bytes.to_vec()),product)
}
pub fn applies_in(bundle:&Arc<SourceBundle>,product:u32)->bool {
    let mut decoder=bundle.decoder();
    super::bounded_source::contains_bounded(product,&mut decoder).unwrap_or(true)
}

/// Explain why a required source oracle cannot model the authored body.
pub fn unmodelled_reason(bytes:&[u8],product:u32)->Option<String> {
    unmodelled_reason_in(&SourceBundle::new(bytes.to_vec()),product)
}
pub fn unmodelled_reason_in(bundle:&Arc<SourceBundle>,product:u32)->Option<String> {
    let mut decoder=bundle.decoder();
    if let Err(reason)=super::bounded_source::contains_bounded(product,&mut decoder){return Some(reason);}
    super::bounded_source::unmodelled_reason(product,&mut decoder)
}
