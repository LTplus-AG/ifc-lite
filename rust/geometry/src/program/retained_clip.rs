// SPDX-License-Identifier: MPL-2.0
//! Reached plain-plane source and derived unary operation. No numerical authority.
use super::retained::{LogicalRetainedSlot, LogicalRetainedValue, RetainedContract};
use crate::processors::boolean::half_space_plan::HalfSpacePlan;
use crate::{BoolOp, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedClipMode { Difference, Intersection }

/// Original coefficients precede orthonormalization, units and object-local conversion.
/// Missing optional axes remain distinguishable from explicit authored defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedPlaneCoefficients {
    pub source_id: u32,
    pub arity: usize,
    pub values: [f64;3],
}
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedPlaneSource {
    pub occurrence: LogicalRetainedSlot,
    pub boolean_id: u32,
    pub half_space_id: u32,
    pub base_surface_id: u32,
    pub position_id: u32,
    pub location: Option<RetainedPlaneCoefficients>,
    pub axis: Option<RetainedPlaneCoefficients>,
    pub ref_direction: Option<RetainedPlaneCoefficients>,
    pub authored_agreement: Option<bool>,
    pub agreement: bool,
    pub length_unit_scale: f64,
    pub source_epoch: u64,
    pub source_revision: u64,
}
#[derive(Debug, Clone, PartialEq)]
pub struct RetainedUnaryClip {
    pub source: RetainedPlaneSource,
    /// Canonical source policy plane, still in original unscaled source units.
    pub source_plane: [f64;6],
    /// Point and covector normal in the selected actual input's local metres.
    pub local_plane: [f64;6],
    pub mode: RetainedClipMode,
    pub input_frame: [f64;16],
}
fn refused(message: &str) -> crate::Error {
    crate::document::RetainedRefusal::UnsupportedSource(message.into()).into()
}
/// Fixed-width capture, with no graph walk, sampling or authored cutter recipe.
fn coefficients(position: &DecodedEntity, index: usize, decoder: &mut EntityDecoder<'_>)
    -> Result<Option<RetainedPlaneCoefficients>> {
    let Some(attribute)=position.get(index).filter(|a|!a.is_null()) else {return Ok(None)};
    crate::resource::check_current()?;
    let entity=decoder.resolve_ref(attribute)?.ok_or_else(||refused("retained plane placement reference missing"))?;
    let expected=if index==slot::IfcAxis2Placement3D::LOCATION.index() {IfcType::IfcCartesianPoint} else {IfcType::IfcDirection};
    if entity.ifc_type!=expected {return Err(refused("retained plane placement coefficient type"));}
    let coefficient_slot=if expected==IfcType::IfcCartesianPoint {slot::IfcCartesianPoint::COORDINATES.index()}
        else {slot::IfcDirection::DIRECTION_RATIOS.index()};
    let values=entity.get(coefficient_slot).and_then(|a|a.as_list()).ok_or_else(||refused("retained plane coefficients missing"))?;
    if !(2..=3).contains(&values.len()) {return Err(refused("retained plane coefficient arity"));}
    let mut raw=[0.;3];
    for (target,value) in raw.iter_mut().zip(values) {
        *target=value.as_float().filter(|v|v.is_finite()).ok_or_else(||refused("retained plane requires finite raw coefficients"))?;
    }
    Ok(Some(RetainedPlaneCoefficients {source_id:entity.id,arity:values.len(),values:raw}))
}
pub(super) struct ClipSourceContext {
    pub scale:f64, pub contract:RetainedContract, pub operator:BoolOp, pub boolean_id:u32, pub program:u64,
}
pub(super) fn capture(half_space: &DecodedEntity, decoder: &mut EntityDecoder<'_>,
    input: &LogicalRetainedValue, context:ClipSourceContext) -> Result<RetainedUnaryClip> {
    let ClipSourceContext {scale,contract,operator,boolean_id,program}=context;
    super::retained_walk::charge(1)?;
    crate::resource::charge(crate::resource::Cost {work:1,occurrences:1,
        copy_bytes:std::mem::size_of::<RetainedUnaryClip>() as u64,..Default::default()})?.retain();
    if half_space.ifc_type!=IfcType::IfcHalfSpaceSolid {
        return Err(refused("retained polygonally bounded halfspace requires separate boundary contract"));
    }
    let mode=match operator {BoolOp::Difference=>RetainedClipMode::Difference,
        BoolOp::Intersection=>RetainedClipMode::Intersection,
        _=>return Err(refused("retained unbounded halfspace Union unavailable"))};
    if !scale.is_finite() || scale<=0. {return Err(refused("retained plane length units invalid"));}
    let (surface_id,position,agreement)=HalfSpacePlan::source(half_space,decoder)?;
    let source=RetainedPlaneSource {
        occurrence:super::retained::next_slot(program)?,boolean_id,half_space_id:half_space.id,
        base_surface_id:surface_id,position_id:position.id,
        location:coefficients(&position,slot::IfcAxis2Placement3D::LOCATION.index(),decoder)?,axis:coefficients(&position,slot::IfcAxis2Placement3D::AXIS.index(),decoder)?,
        ref_direction:coefficients(&position,slot::IfcAxis2Placement3D::REF_DIRECTION.index(),decoder)?,
        authored_agreement:half_space.get(ifc_lite_core::slot::IfcHalfSpaceSolid::AGREEMENT_FLAG.index()).and_then(|v|v.as_bool()),
        agreement,length_unit_scale:scale,source_epoch:contract.source_epoch,source_revision:contract.source_revision,
    };
    // Reuse exact source normalization/default semantics after raw capture.
    let plane=HalfSpacePlan::from_position(&position,decoder,agreement)?;
    let source_plane=[plane.point.x,plane.point.y,plane.point.z,plane.normal.x,plane.normal.y,plane.normal.z];
    let frame=nalgebra::Matrix4::from_column_slice(input.object_frame());
    super::retained::proper_rigid(&frame)?;
    let inverse=frame.try_inverse().ok_or_else(||refused("retained plane input frame singular"))?;
    // F maps actual object-local metres to enclosing representation metres.
    // p_local = F^-1 (s*p_source); n_local = F_linear^T n_source.
    // Uniform positive s drops out of the normal's homogeneous scale.
    let p=inverse*nalgebra::Vector4::new(scale*plane.point.x,scale*plane.point.y,scale*plane.point.z,1.);
    let n=frame.fixed_view::<3,3>(0,0).transpose()*plane.normal;
    let local_plane=[p.x,p.y,p.z,n.x,n.y,n.z];
    if local_plane.iter().any(|v|!v.is_finite()) || n.norm()==0. {
        return Err(refused("retained effective plane invalid"));
    }
    crate::resource::check_current()?;
    Ok(RetainedUnaryClip {source,source_plane,local_plane,mode,input_frame:*input.object_frame()})
}
