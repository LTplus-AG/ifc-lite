// SPDX-License-Identifier: MPL-2.0
//! Independent core decode of halfspace planes and source boundary coordinates.
use super::{clipping::Edge, math::*};
use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::placement::Axis2Placement;
use std::collections::HashSet;

pub(super) struct Clip {
    pub plane: ([f64;3], f64), // removed material satisfies n·x <= c
    pub frame: [f64;16],
    pub edges: Option<Vec<Edge>>,
}
impl Clip {
    pub fn read(id: u32, world: &[f64;16], decoder: &mut EntityDecoder) -> Option<Self> {
        let half=decoder.decode_by_id(id).ok()?;
        if !half.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {return None;}
        let surface=decoder.decode_by_id(half.get_ref(0)?).ok()?;
        if surface.ifc_type!=IfcType::IfcPlane {return None;}
        let position=decoder.decode_by_id(surface.get_ref(0)?).ok()?;
        let local=Axis2Placement::read_3d(&position,decoder).ok()?.matrix();
        let frame=multiply(world,local.as_slice().try_into().ok()?);
        let mut normal=unit(vector(&frame,[0.,0.,1.]))?;
        if !half.get_bool(1)? {normal=normal.map(|v|-v);}
        let plane=(normal,dot(normal,transform(&frame,[0.;3])));
        if half.ifc_type!=IfcType::IfcPolygonalBoundedHalfSpace {
            return Some(Self{plane,frame,edges:None}); // Enclosure is never decoded.
        }
        let position=decoder.decode_by_id(half.get_ref(2)?).ok()?;
        let local=Axis2Placement::read_3d(&position,decoder).ok()?.matrix();
        let frame=multiply(world,local.as_slice().try_into().ok()?);
        let edges=boundary(half.get_ref(3)?,decoder)?;
        Some(Self{plane,frame,edges:Some(edges)})
    }
    pub fn lateral_point(&self,p:[f64;3])->[f64;2] {
        let delta=sub(p,transform(&self.frame,[0.;3]));
        let x=vector(&self.frame,[1.,0.,0.]);let y=vector(&self.frame,[0.,1.,0.]);
        [dot(delta,x)/dot(x,x),dot(delta,y)/dot(y,y)]
    }
}
pub(super) fn chain(product:u32,decoder:&mut EntityDecoder)->Option<(u32,Vec<u32>,bool)> {
    let product=decoder.decode_by_id(product).ok()?;
    let shape=decoder.decode_by_id(product.get_ref(6)?).ok()?;
    let mut items=Vec::new();
    for reference in shape.get(2)?.as_list()? {
        let representation=decoder.decode_by_id(reference.as_entity_ref()?).ok()?;
        if representation.get_string(1).is_some_and(|s|s.eq_ignore_ascii_case("Body")) {
            for item in representation.get(3)?.as_list()? {items.push(item.as_entity_ref()?);}
        }
    }
    if items.len()!=1{return None;}
    let mut cursor=items[0];let mut visited=HashSet::new();let mut clips=Vec::new();let mut solids=false;
    while visited.insert(cursor) && visited.len()<=128 {
        let node=decoder.decode_by_id(cursor).ok()?;
        if !node.ifc_type.is_subtype_of(IfcType::IfcBooleanResult) {return Some((cursor,clips,solids));}
        if node.get(0)?.as_enum()?.trim_matches('.')!="DIFFERENCE" {return None;}
        let right=decoder.decode_by_id(node.get_ref(2)?).ok()?;
        if right.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {clips.push(right.id);}else{solids=true;}
        cursor=node.get_ref(1)?;
    }
    None
}
fn boundary(id:u32,decoder:&mut EntityDecoder)->Option<Vec<Edge>> {
    let curve=decoder.decode_by_id(id).ok()?;
    match curve.ifc_type {
        IfcType::IfcPolyline => {
            let refs=curve.get(0)?.as_list()?;if refs.len()>257{return None;}
            let points=refs.iter().map(|r|decoder.point3(r.as_entity_ref()?).ok().map(|p|[p[0],p[1]])).collect::<Option<Vec<_>>>()?;
            Some(points.windows(2).map(|p|Edge::Line(p[0],p[1])).collect())
        }
        IfcType::IfcIndexedPolyCurve => {
            let list=decoder.decode_by_id(curve.get_ref(0)?).ok()?;
            let points=list.get(0)?.as_list()?.iter().map(|row|{let v=row.as_list()?;Some([v.first()?.as_float()?,v.get(1)?.as_float()?])}).collect::<Option<Vec<_>>>()?;
            let point=|i:&ifc_lite_core::AttributeValue|points.get(i.as_ifc_index()?.checked_sub(1)? as usize).copied();
            let mut edges=Vec::new();
            for segment in curve.get(1)?.as_list()? {
                let (name,value)=segment.as_typed()?;let ids=value.as_list()?;
                if name.eq_ignore_ascii_case("IfcLineIndex") {
                    for pair in ids.windows(2){edges.push(Edge::Line(point(&pair[0])?,point(&pair[1])?));}
                } else if name.eq_ignore_ascii_case("IfcArcIndex") && ids.len()==3 {
                    edges.push(arc(point(&ids[0])?,point(&ids[1])?,point(&ids[2])?)?);
                }else{return None;}
                if edges.len()>256{return None;}
            }
            Some(edges)
        }
        _=>None,
    }
}
fn arc(a:[f64;2],b:[f64;2],c:[f64;2])->Option<Edge> {
    let (bx,by,cx,cy)=(b[0]-a[0],b[1]-a[1],c[0]-a[0],c[1]-a[1]);
    let d=2.*(bx*cy-by*cx);if d==0.{return None;}
    let x=(cy*(bx*bx+by*by)-by*(cx*cx+cy*cy))/d;
    let y=(bx*(cx*cx+cy*cy)-cx*(bx*bx+by*by))/d;
    let center=[a[0]+x,a[1]+y];let radius=x.hypot(y);
    let start=(-y).atan2(-x);let end=(c[1]-center[1]).atan2(c[0]-center[0]);
    let tau=std::f64::consts::TAU;
    let sweep=if d>0.{(end-start).rem_euclid(tau)}else{-((start-end).rem_euclid(tau))};
    Some(Edge::Arc{c:center,u:[radius,0.],v:[0.,radius],a:start,sweep})
}
