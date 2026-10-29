// SPDX-License-Identifier: MPL-2.0
//! Independent IFC trim interpretation for the bounded-halfspace source oracle.
//! Only core leaves and placements are shared; no production curve decoder.
use super::{clipping::Edge, math::*};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType, slot};
use ifc_lite_geometry::placement::Axis2Placement;
use std::f64::consts::TAU;

enum Trim { Point([f64;3]), Parameter(f64) }
fn trim(curve: &DecodedEntity, index: usize, decoder: &mut EntityDecoder) -> Option<Trim> {
    let mut point=None;
    let mut parameter=None;
    for value in curve.get(index)?.as_list()? {
        if let Some(id)=value.as_entity_ref() {
            point=Some(Trim::Point(decoder.point3(id).ok()?));
        } else {
            let t=value.typed_value("IFCPARAMETERVALUE").unwrap_or(value).as_float()?;
            if !t.is_finite(){return None;}
            parameter=Some(Trim::Parameter(t));
        }
    }
    if curve.get(slot::IfcTrimmedCurve::MASTER_REPRESENTATION.index())?.as_enum()?=="CARTESIAN" {
        point.or(parameter)
    }else{parameter.or(point)}
}

pub(super) fn circle(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Edge> {
    let position=decoder.decode_by_id(curve.get_ref(slot::IfcCircle::POSITION.index())?).ok()?;
    let placement=match position.ifc_type {
        IfcType::IfcAxis2Placement2D=>Axis2Placement::read_2d(&position,decoder).ok()?,
        IfcType::IfcAxis2Placement3D=>Axis2Placement::read_3d(&position,decoder).ok()?,
        _=>return None,
    }.matrix();
    // A boundary circle must lie in the Position XY plane. Store its arc in
    // world-XY angles, keeping the winding/nearest-point oracle canonical.
    if placement[(2,0)].abs()>1e-12 || placement[(2,1)].abs()>1e-12 {return None;}
    let radius=curve.get(slot::IfcCircle::RADIUS.index())?.as_float()?;
    if !radius.is_finite()||radius<=0.{return None;}
    let orientation=(placement[(0,0)]*placement[(1,1)]-placement[(1,0)]*placement[(0,1)]).signum();
    Some(Edge::Arc{c:[placement[(0,3)],placement[(1,3)]],u:[radius,0.],v:[0.,radius],
        a:placement[(1,0)].atan2(placement[(0,0)]),sweep:orientation*TAU})
}

pub(super) fn trimmed(curve: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<Edge> {
    let basis=decoder.decode_by_id(curve.get_ref(slot::IfcTrimmedCurve::BASIS_CURVE.index())?).ok()?;
    let first=trim(curve,slot::IfcTrimmedCurve::TRIM1.index(),decoder)?;
    let last=trim(curve,slot::IfcTrimmedCurve::TRIM2.index(),decoder)?;
    match basis.ifc_type {
        IfcType::IfcLine=>{
            let origin=decoder.point3(basis.get_ref(slot::IfcLine::PNT.index())?).ok()?;
            let vector=decoder.decode_by_id(basis.get_ref(slot::IfcLine::DIR.index())?).ok()?;
            let direction=unit(decoder.direction3(vector.get_ref(slot::IfcVector::ORIENTATION.index())?).ok()?)?;
            let magnitude=vector.get(slot::IfcVector::MAGNITUDE.index())?.as_float()?;
            if !magnitude.is_finite() || magnitude<=0.{return None;}
            let point=|t| match t {
                Trim::Point(p)=>[p[0],p[1]],
                Trim::Parameter(t)=>[origin[0]+t*magnitude*direction[0],origin[1]+t*magnitude*direction[1]],
            };
            // Trim1 is the start even when SenseAgreement is false (descending
            // line parameters). Composite SameSense is applied by the caller.
            Some(Edge::Line(point(first),point(last)))
        }
        IfcType::IfcCircle=>{
            let Edge::Arc{c,u,v,a,sweep}=circle(&basis,decoder)? else{return None;};
            let orientation=sweep.signum();
            let scale=decoder.plane_angle_to_radians();
            let angle=|t| match t {
                Trim::Point(p)=>(p[1]-c[1]).atan2(p[0]-c[0]),
                Trim::Parameter(t)=>a+orientation*t*scale,
            };
            let start=angle(first);let end=angle(last);
            let sense=if curve.get_bool(slot::IfcTrimmedCurve::SENSE_AGREEMENT.index())? {orientation}else{-orientation};
            let mut span=((end-start)*sense).rem_euclid(TAU);
            if span<1e-12 {span=TAU;}
            Some(Edge::Arc{c,u,v,a:start,sweep:sense*span})
        }
        _=>None,
    }
}
