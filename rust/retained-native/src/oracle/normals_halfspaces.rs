// SPDX-License-Identifier: MPL-2.0
//! #7955 M6: independent source normals for the cut plane and boundary walls.
//! Decode IFC source edges, never the retained prism or its tessellation.
use super::Surface;
use super::super::{bounded_source::Clip, clipping::Edge, math::*};
use ifc_lite_core::EntityDecoder;

fn handedness(frame: &[f64;16]) -> f64 {
    dot(vector(frame,[1.,0.,0.]),cross(vector(frame,[0.,1.,0.]),vector(frame,[0.,0.,1.]))).signum()
}
pub(super) fn surfaces(id: u32, world: &[f64;16], decoder: &mut EntityDecoder<'_>) -> Result<Vec<Surface>,String> {
    let clip = Clip::read(id,world,decoder).ok_or("unresolved halfspace normal source")?;
    // Clip's removed material is n.x <= c. Its outward normal is +n;
    // the enclosing Difference reverses it in the orientation walk.
    let mut result = vec![Surface::Plane {
        origin:clip.plane.0.map(|v|v*clip.plane.1),
        normal:clip.plane.0.map(|v|v*handedness(world)),
    }];
    let Some(edges) = clip.edges else {return Ok(result)};
    let area: f64 = edges.iter().map(Edge::integral).sum();
    if !area.is_finite() || area == 0. {return Err("invalid halfspace boundary area".into());}
    let sign = area.signum()*handedness(&clip.frame);
    let d = vector(&clip.frame,[0.,0.,1.]);
    for edge in edges {
        result.push(match edge {
            Edge::Line(a,b) => Surface::Plane {
                origin:transform(&clip.frame,[a[0],a[1],0.]),
                normal:unit(cross(vector(&clip.frame,[b[0]-a[0],b[1]-a[1],0.]),d))
                    .ok_or("degenerate halfspace side")?.map(|v|v*sign),
            },
            Edge::Arc {c,u,v,sweep,..} => Surface::ArcWall {
                center:transform(&clip.frame,[c[0],c[1],0.]),
                u:vector(&clip.frame,[u[0],u[1],0.]),v:vector(&clip.frame,[v[0],v[1],0.]),
                d,sign:sign*sweep.signum(),
            },
        });
    }
    Ok(result)
}
