// SPDX-License-Identifier: MPL-2.0
//! Integrate a curved source prism against the host's exact linear partition.
//! This exchanges the two section operands; no tessellation supplies the volume.
use super::{bounded_source::Clip, bounded_partition::extrusion_pieces,
    clipping::Edge, math::*, sections::{ExtrudedHost, section_volume}};

pub(super) fn result_volume(host:&ExtrudedHost, clip:&Clip)->Option<f64> {
    let partitions=extrusion_pieces(host)?;
    let edges=clip.edges.as_ref()?;
    let axis=unit(vector(&clip.frame,[0.,0.,1.]))?;
    let origin=transform(&clip.frame,[0.;3]);
    // Linear host vertices and both physical caps bound its entire projection
    // along the source boundary's prism axis (including non-convex profiles).
    let mut low=f64::INFINITY;let mut high=f64::NEG_INFINITY;
    for (_,boundary) in &host.loops {for edge in boundary {
        let Edge::Line(a,b)=edge else{return None;};
        for p in [a,b] {for t in [0.,host.depth] {
            let base=transform(&host.frame,[p[0],p[1],0.]);
            let point=std::array::from_fn(|i|base[i]+host.direction[i]*t);
            let z=dot(axis,sub(point,origin));low=low.min(z);high=high.max(z);
        }}
    }}
    if !low.is_finite() || !high.is_finite() || high<=low {return None;}
    let mut frame=clip.frame;
    for i in 0..3 {frame[12+i]+=axis[i]*low;}
    let jacobian=dot(cross(vector(&frame,[1.,0.,0.]),vector(&frame,[0.,1.,0.])),axis).abs();
    let prism=ExtrudedHost{loops:vec![(true,edges.clone())],frame,direction:axis,depth:high-low,jacobian};
    let mut removed=0.;
    for mut planes in partitions {
        planes.push(clip.plane);
        removed+=section_volume(&prism,&planes)?;
    }
    let volume=section_volume(host,&[])?-removed;
    (volume.is_finite()&&volume>=-1e-10).then_some(volume.max(0.))
}
