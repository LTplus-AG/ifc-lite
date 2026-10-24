// SPDX-License-Identifier: MPL-2.0
//! Straight indexed boundaries preserve the complete coordinate and index source.
use super::{clip::{refused, RetainedPlaneCoefficients}, finite_source::MAX_POINTS};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use crate::Result;
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedIndexedBoundary {
    pub point_list_id: u32,
    pub coordinates: Vec<[f64; 2]>,
    pub segments: Option<Vec<Vec<usize>>>,
    pub self_intersect: Option<bool>,
}
pub(super) fn capture_indexed_boundary(curve: &DecodedEntity, decoder: &mut EntityDecoder)
    -> Result<(RetainedIndexedBoundary, Vec<RetainedPlaneCoefficients>)> {
    let point_list = decoder.resolve_ref(curve.get(0).ok_or_else(|| refused("indexed boundary Points missing"))?)?
        .ok_or_else(|| refused("indexed boundary Points unresolved"))?;
    if point_list.ifc_type != IfcType::IfcCartesianPointList2D { return Err(refused("indexed boundary must be 2D")); }
    let raw = point_list.get(0).and_then(|v|v.as_list()).ok_or_else(|| refused("indexed boundary CoordList missing"))?;
    if !(3..=MAX_POINTS+1).contains(&raw.len()) { return Err(refused("indexed boundary coordinate budget")); }
    let mut coordinates = Vec::new();
    crate::resource::reserve_headers(&mut coordinates, raw.len())?.retain();
    for value in raw {
        let pair = value.as_list().filter(|v|v.len()==2).ok_or_else(|| refused("indexed boundary coordinate arity"))?;
        let mut p = [0.;2];
        for i in 0..2 { p[i] = pair[i].as_float().filter(|v|v.is_finite()).ok_or_else(|| refused("nonfinite indexed boundary"))?; }
        coordinates.push(p);
    }
    let self_intersect = match curve.get(2).filter(|v|!v.is_null()) {
        None => None,
        Some(v) => Some(v.as_bool().ok_or_else(|| refused("invalid indexed SelfIntersect"))?),
    };
    if self_intersect == Some(true) { return Err(refused("self-intersecting indexed boundary")); }
    let mut order = Vec::new();
    crate::resource::reserve_headers(&mut order, MAX_POINTS+1)?.retain();
    let segments = if let Some(value) = curve.get(1).filter(|v|!v.is_null()) {
        let raw = value.as_list().filter(|v|v.len() <= MAX_POINTS).ok_or_else(|| refused("indexed segment budget"))?;
        let mut segments = Vec::new();
        crate::resource::reserve_headers(&mut segments, raw.len())?.retain();
        let mut entries = 0;
        for item in raw {
            let (kind, values) = item.as_typed().ok_or_else(|| refused("indexed boundary segment type"))?;
            if kind != "IFCLINEINDEX" { return Err(refused("analytic arc boundary unavailable")); }
            let values = values.as_list().filter(|v| v.len() >= 2).ok_or_else(|| refused("indexed boundary line arity"))?;
            entries += values.len();
            if entries > 2*MAX_POINTS { return Err(refused("indexed boundary index budget")); }
            let mut indices = Vec::new();
            crate::resource::reserve_headers(&mut indices, values.len())?.retain();
            for value in values {
                let index = value.as_float().filter(|v|v.is_finite() && v.fract()==0. && *v >= 1. && *v <= coordinates.len() as f64)
                    .ok_or_else(|| refused("indexed boundary index range"))? as usize;
                indices.push(index);
            }
            if order.last().is_some_and(|last| *last != indices[0]) { return Err(refused("disconnected indexed boundary")); }
            let skip = usize::from(!order.is_empty());
            if order.len()+indices.len()-skip > MAX_POINTS+1 { return Err(refused("indexed boundary edge budget")); }
            order.extend_from_slice(&indices[skip..]);
            segments.push(indices);
        }
        Some(segments)
    } else {
        order.extend(1..=coordinates.len());
        None
    };
    if order.len() < 4 { return Err(refused("indexed boundary has fewer than three edges")); }
    let mut points = Vec::new();
    crate::resource::reserve_headers(&mut points, order.len())?.retain();
    for index in order {
        crate::resource::charge(crate::resource::Cost {work:1,..Default::default()})?.retain();
        let p = coordinates[index-1];
        points.push(RetainedPlaneCoefficients {source_id:point_list.id,arity:2,values:[p[0],p[1],0.]});
    }
    Ok((RetainedIndexedBoundary { point_list_id:point_list.id,coordinates,segments,self_intersect },points))
}
