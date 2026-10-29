// SPDX-License-Identifier: MPL-2.0
//! Independent core decode of halfspace planes and source boundary coordinates.
use super::{clipping::Edge, math::*};
use ifc_lite_core::{EntityDecoder, IfcType, slot};
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
        let surface=decoder.decode_by_id(half.get_ref(slot::IfcHalfSpaceSolid::BASE_SURFACE.index())?).ok()?;
        if surface.ifc_type!=IfcType::IfcPlane {return None;}
        let position=decoder.decode_by_id(surface.get_ref(slot::IfcPlane::POSITION.index())?).ok()?;
        let local=Axis2Placement::read_3d(&position,decoder).ok()?.matrix();
        let frame=multiply(world,local.as_slice().try_into().ok()?);
        // cross(Mx,My) carries det(M); remove its sign to obtain M^-T z.
        let sign=orientation(&frame)?;
        let mut normal=unit(cross(vector(&frame,[1.,0.,0.]),vector(&frame,[0.,1.,0.])))?.map(|v|v*sign);
        if !half.get_bool(slot::IfcHalfSpaceSolid::AGREEMENT_FLAG.index())? {normal=normal.map(|v|-v);}
        let plane=(normal,dot(normal,transform(&frame,[0.;3])));
        if half.ifc_type!=IfcType::IfcPolygonalBoundedHalfSpace {
            return Some(Self{plane,frame,edges:None}); // Enclosure is never decoded.
        }
        let position=decoder.decode_by_id(half.get_ref(slot::IfcPolygonalBoundedHalfSpace::POSITION.index())?).ok()?;
        let local=Axis2Placement::read_3d(&position,decoder).ok()?.matrix();
        let frame=multiply(world,local.as_slice().try_into().ok()?);
        let edges=boundary(half.get_ref(slot::IfcPolygonalBoundedHalfSpace::POLYGONAL_BOUNDARY.index())?,decoder)?;
        Some(Self{plane,frame,edges:Some(edges)})
    }
    pub fn lateral_point(&self,p:[f64;3])->[f64;2] {
        let delta=sub(p,transform(&self.frame,[0.;3]));
        let x=vector(&self.frame,[1.,0.,0.]);let y=vector(&self.frame,[0.,1.,0.]);
        let z=vector(&self.frame,[0.,0.,1.]);let det=dot(x,cross(y,z));
        // Reciprocal basis pulls back to authored XY, preserving local winding
        // and circular arc crossing orientation even through mirrors/shear.
        [dot(delta,cross(y,z))/det,dot(delta,cross(z,x))/det]
    }
}
/// Handedness of an invertible source frame; singular frames have no oracle.
pub(super) fn orientation(frame:&[f64;16])->Option<f64> {
    let det=dot(vector(frame,[1.,0.,0.]),cross(vector(frame,[0.,1.,0.]),vector(frame,[0.,0.,1.])));
    (det.is_finite() && det!=0.).then_some(det.signum())
}
pub(super) struct Chain {
    pub host: u32,
    pub host_frame: [f64;16],
    pub clips: Vec<(u32,[f64;16])>,
    pub solid_cuts: bool,
}
pub(super) fn chain(product:u32,decoder:&mut EntityDecoder)->Option<Chain> {
    let product=decoder.decode_by_id(product).ok()?;
    let shape=decoder.decode_by_id(product.get_ref(slot::IfcProduct::REPRESENTATION.index())?).ok()?;
    let mut items=Vec::new();
    for reference in shape.get(slot::IfcProductRepresentation::REPRESENTATIONS.index())?.as_list()? {
        let representation=decoder.decode_by_id(reference.as_entity_ref()?).ok()?;
        if representation.get_string(slot::IfcRepresentation::REPRESENTATION_IDENTIFIER.index()).is_some_and(|s|s.eq_ignore_ascii_case("Body")) {
            for item in representation.get(slot::IfcRepresentation::ITEMS.index())?.as_list()? {items.push(item.as_entity_ref()?);}
        }
    }
    if items.len()!=1{return None;}
    let mut frame=IDENTITY;
    let mut cursor=items[0];let mut visited=HashSet::new();let mut clips=Vec::new();let mut solids=false;
    while visited.insert(cursor) && visited.len()<=128 {
        let node=decoder.decode_by_id(cursor).ok()?;
        if node.ifc_type==IfcType::IfcMappedItem {
            let map=decoder.decode_by_id(node.get_ref(slot::IfcMappedItem::MAPPING_SOURCE.index())?).ok()?;
            let mapped_rep=decoder.decode_by_id(map.get_ref(slot::IfcRepresentationMap::MAPPED_REPRESENTATION.index())?).ok()?;
            let children=mapped_rep.get(slot::IfcRepresentation::ITEMS.index())?.as_list()?;
            if children.len()!=1{return None;}
            cursor=children[0].as_entity_ref()?;
            let level=ifc_lite_geometry::representation::MappedLevel{item:node,map,mapped_rep};
            let local=level.local_transform(decoder).ok()?
                .map(|m|m.as_slice().try_into().unwrap()).unwrap_or(IDENTITY);
            frame=multiply(&frame,&local);
            continue;
        }
        if node.ifc_type==IfcType::IfcCsgSolid {
            cursor=node.get_ref(slot::IfcCsgSolid::TREE_ROOT_EXPRESSION.index())?;continue;
        }
        if !node.ifc_type.is_subtype_of(IfcType::IfcBooleanResult) {
            return Some(Chain{host:cursor,host_frame:frame,clips,solid_cuts:solids});
        }
        if node.get(slot::IfcBooleanResult::OPERATOR.index())?.as_enum()?.trim_matches('.')!="DIFFERENCE" {return None;}
        let right=decoder.decode_by_id(node.get_ref(slot::IfcBooleanResult::SECOND_OPERAND.index())?).ok()?;
        if right.ifc_type.is_subtype_of(IfcType::IfcHalfSpaceSolid) {clips.push((right.id,frame));}else{solids=true;}
        cursor=node.get_ref(slot::IfcBooleanResult::FIRST_OPERAND.index())?;
    }
    None
}
fn boundary(id:u32,decoder:&mut EntityDecoder)->Option<Vec<Edge>> {
    read_loop(id,decoder,&mut HashSet::new())
}
fn read_loop(id:u32,decoder:&mut EntityDecoder,path:&mut HashSet<u32>)->Option<Vec<Edge>> {
    if path.len()>=128 || !path.insert(id){return None;}
    let result=read_edges(id,decoder,path);path.remove(&id);result
}
fn read_edges(id:u32,decoder:&mut EntityDecoder,path:&mut HashSet<u32>)->Option<Vec<Edge>> {
    let curve=decoder.decode_by_id(id).ok()?;
    match curve.ifc_type {
        IfcType::IfcCompositeCurve => {
            let mut edges=Vec::new();
            for reference in curve.get(slot::IfcCompositeCurve::SEGMENTS.index())?.as_list()? {
                let segment=decoder.decode_by_id(reference.as_entity_ref()?).ok()?;
                let mut child=read_loop(segment.get_ref(slot::IfcCompositeCurveSegment::PARENT_CURVE.index())?,decoder,path)?;
                if !segment.get_bool(slot::IfcCompositeCurveSegment::SAME_SENSE.index())? {
                    child=child.into_iter().rev().map(|e|match e {
                        Edge::Line(a,b)=>Edge::Line(b,a),
                        Edge::Arc{c,u,v,a,sweep}=>Edge::Arc{c,u,v,a:a+sweep,sweep:-sweep},
                    }).collect();
                }
                if edges.len()+child.len()>256{return None;}edges.extend(child);
            }
            Some(edges)
        }
        IfcType::IfcCircle => Some(vec![super::bounded_trim::circle(&curve,decoder)?]),
        IfcType::IfcTrimmedCurve => Some(vec![super::bounded_trim::trimmed(&curve,decoder)?]),
        IfcType::IfcPolyline => {
            let refs=curve.get(slot::IfcPolyline::POINTS.index())?.as_list()?;if refs.len()>257{return None;}
            let points=refs.iter().map(|r|decoder.point3(r.as_entity_ref()?).ok().map(|p|[p[0],p[1]])).collect::<Option<Vec<_>>>()?;
            Some(points.windows(2).map(|p|Edge::Line(p[0],p[1])).collect())
        }
        IfcType::IfcIndexedPolyCurve => {
            let list=decoder.decode_by_id(curve.get_ref(slot::IfcIndexedPolyCurve::POINTS.index())?).ok()?;
            let points=list.get(slot::IfcCartesianPointList2D::COORD_LIST.index())?.as_list()?.iter().map(|row|{let [x,y,..]=row.as_list()? else{return None;};Some([x.as_float()?,y.as_float()?])}).collect::<Option<Vec<_>>>()?;
            let point=|i:&ifc_lite_core::AttributeValue|points.get(i.as_ifc_index()? as usize).copied();
            let mut edges=Vec::new();
            let segments=curve.get(slot::IfcIndexedPolyCurve::SEGMENTS.index());
            if segments.is_none_or(ifc_lite_core::AttributeValue::is_null) {
                if points.len()>257{return None;}
                return Some(points.windows(2).map(|p|Edge::Line(p[0],p[1])).collect());
            }
            for segment in segments?.as_list()? {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m6_7955_mirrored_plane_preserves_removed_side() {
        let bytes=include_bytes!("../../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
        let bundle=ifc_lite_core::SourceBundle::new(bytes.to_vec());
        let mut decoder=bundle.decoder();
        let plain=Clip::read(344,&IDENTITY,&mut decoder).unwrap();
        let mut mirror=IDENTITY;mirror[0]= -2.;mirror[5]=3.;
        let reflected=Clip::read(344,&mirror,&mut decoder).unwrap();
        for p in [[1.,1.,0.],[1.,1.,3.]] {
            let removed=plain.plane.1-dot(plain.plane.0,p);
            let mirrored=reflected.plane.1-dot(reflected.plane.0,transform(&mirror,p));
            assert_eq!(removed,mirrored,"removed side at {p:?}");
        }
    }
}

#[cfg(test)]
#[test]
fn m6_7955_reflected_boundary_pullback_and_partition_sides() {
    let bytes=include_bytes!("../../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
    let bundle=ifc_lite_core::SourceBundle::new(bytes.to_vec());let mut decoder=bundle.decoder();
    // Reflect X or Z, then also exercise non-orthogonal mapped axes.
    for (x,z,shear) in [(-2.,1.,0.),(2.,-1.,0.),(-2.,1.,0.5)] {
        let mut frame=IDENTITY;frame[0]=x;frame[5]=3.;frame[10]=z;frame[4]=shear;
        for id in [307,340] { // linear interior boundary and analytic arc
            let plain=Clip::read(id,&IDENTITY,&mut decoder).unwrap();
            let clip=Clip::read(id,&frame,&mut decoder).unwrap();
            for p in [[1.,1.,3.],[3.,1.,3.],[0.5,0.5,3.]] {
                let world=transform(&frame,p);
                let a=super::bounded_partition::inside_distance(plain.edges.as_ref().unwrap(),plain.lateral_point(p));
                let b=super::bounded_partition::inside_distance(clip.edges.as_ref().unwrap(),clip.lateral_point(world));
                assert!((a-b).abs()<1e-12,"boundary #{id}, {world:?}: {a} vs {b}");
                if id==307 {
                    let contains=|c:&Clip,q|super::bounded_partition::pieces(c).unwrap().iter().any(|piece|piece.iter().all(|(n,d)|dot(*n,q)<=*d+1e-12));
                    assert_eq!(contains(&plain,p),contains(&clip,world),"partition {p:?}");
                }
            }
        }
    }
}
