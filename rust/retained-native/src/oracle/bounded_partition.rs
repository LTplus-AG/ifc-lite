// SPDX-License-Identifier: MPL-2.0
//! Ear partition for simple non-convex linear boundaries, never their hull.
use super::{clipping::Edge, math::*, bounded_source::Clip};
pub(super) type Plane=([f64;3],f64);
pub(super) fn pieces(clip:&Clip)->Option<Vec<Vec<Plane>>> {
    let Some(edges)=&clip.edges else{return Some(vec![vec![clip.plane]]);};
    let mut points=Vec::new();
    for edge in edges {let Edge::Line(a,_) =edge else{return None;};points.push(*a);}
    if points.len()<3||points.len()>256{return None;}
    let area=edges.iter().map(Edge::integral).sum::<f64>();
    if area<0.{points.reverse();}
    let triangles=triangles(points)?;
    let axis=unit(vector(&clip.frame,[0.,0.,1.]))?;
    triangles.into_iter().map(|t| {
        let mut planes=vec![clip.plane];
        for i in 0..3 {
            let p=transform(&clip.frame,[t[i][0],t[i][1],0.]);let q=transform(&clip.frame,[t[(i+1)%3][0],t[(i+1)%3][1],0.]);
            let n=unit(cross(sub(q,p),axis))?;planes.push((n,dot(n,p)));
        }
        Some(planes)
    }).collect()
}
fn cross2(a:[f64;2],b:[f64;2],c:[f64;2])->f64 {(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])}
pub(super) fn triangles(mut p:Vec<[f64;2]>)->Option<Vec<[[f64;2];3]>> {
    if p.len()<3 || p.len()>256{return None;}
    let mut out=Vec::new();let mut budget=256*256*256;
    while p.len()>3 {
        let mut ear=None;
        for i in 0..p.len() {
            let prev=(i+p.len()-1)%p.len();let next=(i+1)%p.len();let (a,b,c)=(p[prev],p[i],p[next]);
            if cross2(a,b,c)<=0.{continue;}
            let mut occupied=false;
            for (j,&q) in p.iter().enumerate() {
                budget-=1;if budget==0{return None;}
                if j==prev||j==i||j==next{continue;}
                if cross2(a,b,q)>=0.&&cross2(b,c,q)>=0.&&cross2(c,a,q)>=0.{occupied=true;break;}
            }
            if !occupied{ear=Some((i,[a,b,c]));break;}
        }
        let (i,t)=ear?;out.push(t);p.remove(i);
    }
    out.push([p[0],p[1],p[2]]);Some(out)
}
/// Signed inside clearance for a linear loop (ray crossing + nearest edge).
/// The Arc case uses an exact winding integral and analytic nearest points.
pub(super) fn inside_distance(edges:&[Edge],p:[f64;2])->f64 {
    let mut winding=0i32;let mut distance=f64::INFINITY;
    for edge in edges {
        match *edge {
            Edge::Line(a,b)=>{
                let (x,y)=(b[0]-a[0],b[1]-a[1]);let t=(((p[0]-a[0])*x+(p[1]-a[1])*y)/(x*x+y*y)).clamp(0.,1.);
                distance=distance.min((p[0]-a[0]-t*x).hypot(p[1]-a[1]-t*y));
                if a[1]<=p[1]&&b[1]>p[1]&&cross2(a,b,p)>0.{winding+=1;}
                if a[1]>p[1]&&b[1]<=p[1]&&cross2(a,b,p)<0.{winding-=1;}
            }
            Edge::Arc{c,u,v,a,sweep}=>{
                let radius=u[0].hypot(u[1]);let angle=(p[1]-c[1]).atan2(p[0]-c[0]);
                let t=(if sweep>0.{(angle-a).rem_euclid(std::f64::consts::TAU)}else{(a-angle).rem_euclid(std::f64::consts::TAU)})/sweep.abs();
                if t<=1.{distance=distance.min(((p[0]-c[0]).hypot(p[1]-c[1])-radius).abs());}
                for endpoint in [edge.point(0.),edge.point(1.)]{distance=distance.min((p[0]-endpoint[0]).hypot(p[1]-endpoint[1]));}
                // Ray roots y=p.y for the independent circle parameterization.
                let y=(p[1]-c[1])/radius;
                if y.abs()<=1. {
                    for (root,theta) in [y.asin(),std::f64::consts::PI-y.asin()].into_iter().enumerate() {
                        // A horizontal tangent has one root. In the interior it
                        // only touches the ray; at a loop joint it still needs
                        // the same lower-endpoint ownership as the adjacent line.
                        if y.abs()==1. && root==1 {continue;}
                        let t=(if sweep>0.{(theta-a).rem_euclid(std::f64::consts::TAU)}else{(a-theta).rem_euclid(std::f64::consts::TAU)})/sweep.abs();
                        // Match the line rule: include the lower-y endpoint and
                        // exclude the upper-y endpoint, regardless of traversal.
                        let up=if y.abs()==1. {
                            if t!=0. && t!=1. {continue;}
                            -y*(if t==0. {1.}else{-1.})>0.
                        }else{sweep*theta.cos()>0.};
                        let t=if !up && t==0. && sweep.abs()==std::f64::consts::TAU {1.}else{t};
                        let crosses=if up {t<1.}else{t>0.&&t<=1.};
                        if crosses && c[0]+u[0]*theta.cos()+v[0]*theta.sin()>p[0] {
                            winding+=if up {1}else{-1};
                        }
                    }
                }
            }
        }
    }
    if winding==0 {-distance}else{distance}
}

/// A finite source extrusion partition, including both physical end caps.
pub(super) fn extrusion_pieces(host:&super::sections::ExtrudedHost)->Option<Vec<Vec<Plane>>> {
    if host.loops.len()!=1 || !host.loops[0].0{return None;}
    let mut points=Vec::new();for edge in &host.loops[0].1 {
        let Edge::Line(a,_) = edge else{return None;};points.push(*a);
    }
    if host.loops[0].1.iter().map(Edge::integral).sum::<f64>()<0.{points.reverse();}
    let direction=host.direction;
    let n=unit(cross(vector(&host.frame,[1.,0.,0.]),vector(&host.frame,[0.,1.,0.])))?;
    let base=transform(&host.frame,[0.;3]);let height=dot(n,direction)*host.depth;
    if height==0.{return None;}
    let (low,high)=(dot(n,base)+height.min(0.),dot(n,base)+height.max(0.));
    triangles(points)?.into_iter().map(|t| {
        let mut planes=vec![(n,high),(n.map(|x|-x),-low)];
        for i in 0..3 {
            let p=transform(&host.frame,[t[i][0],t[i][1],0.]);let q=transform(&host.frame,[t[(i+1)%3][0],t[(i+1)%3][1],0.]);
            let mut normal=unit(cross(sub(q,p),direction))?;
            if height<0.{normal=normal.map(|x|-x);}
            planes.push((normal,dot(normal,p)));
        }
        Some(planes)
    }).collect()
}

#[cfg(test)]
#[path = "bounded_partition_tests.rs"]
mod tests;
