// SPDX-License-Identifier: MPL-2.0
//! Finite halfspace set algebra over owned host clips. No enclosing mesh cutter.
use super::{LogicalRetainedValue, RetainedPlanOperation, RetainedUnaryClip, RetainedClipMode};
use super::{finite_source::RetainedFiniteBoundary, clip::{refused, operation}};
use crate::{Result, BoolOp};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::sync::Arc;

/// Source evidence is shared immutably across all component operations. Private
/// fields prevent callers from relabelling a side wall as an authored base plane.
#[derive(Debug, Clone, PartialEq)]
pub struct FiniteClipPlane {
    boundary: Arc<RetainedFiniteBoundary>,
    cell: usize,
    edge: Option<usize>,
    source_plane: [f64; 6],
}
impl FiniteClipPlane {
    pub fn boundary(&self) -> &RetainedFiniteBoundary { &self.boundary }
    pub fn cell(&self) -> usize { self.cell }
    pub fn edge(&self) -> Option<usize> { self.edge }
    pub fn source_plane(&self) -> &[f64; 6] { &self.source_plane }
    pub fn is_base(&self) -> bool { self.edge.is_none() }
}
type Cell = Vec<[f64; 6]>;
fn plane(frame: &[f64; 16], point: [f64; 3], normal: [f64; 3]) -> Result<[f64; 6]> {
    let f = nalgebra::Matrix4::from_column_slice(frame);
    let p = f * nalgebra::Vector4::new(point[0],point[1],point[2],1.);
    let n = f.fixed_view::<3,3>(0,0) * nalgebra::Vector3::from(normal);
    let output = [p.x,p.y,p.z,n.x,n.y,n.z];
    crate::document::retained_plane::validate_plane(&output).map_err(refused)?;
    Ok(output)
}
fn domains(boundary: &RetainedFiniteBoundary) -> Result<Vec<Cell>> {
    let mut result = Vec::new();
    match boundary {
        RetainedFiniteBoundary::Box { placement, corner, dimensions, .. } => {
            let mut cell = Vec::new();
            crate::resource::reserve_headers(&mut cell, 6)?.retain();
            for axis in 0..3 {
                for upper in [false, true] {
                    let mut point = corner.values;
                    if upper { point[axis] += dimensions[axis]; }
                    let mut normal = [0.;3]; normal[axis] = if upper {-1.} else {1.};
                    cell.push(plane(&placement.frame,point,normal)?);
                }
            }
            crate::resource::reserve_headers(&mut result, 1)?.retain();
            result.push(cell);
        }
        RetainedFiniteBoundary::Polygon { placement, points, .. } => {
            let mut xy = Vec::new();
            crate::resource::reserve_headers(&mut xy, points.len()-1)?.retain();
            xy.extend(points[..points.len()-1].iter().map(|p| [p.values[0],p.values[1]]));
            let cells = super::finite_partition::cells(&xy)?;
            crate::resource::reserve_headers(&mut result, cells.len())?.retain();
            for indices in cells {
                let mut cell = Vec::new();
                crate::resource::reserve_headers(&mut cell, indices.len())?.retain();
                for i in 0..indices.len() {
                    let a = xy[indices[i]]; let b = xy[indices[(i+1)%indices.len()]];
                    cell.push(plane(&placement.frame,[a[0],a[1],0.],[a[1]-b[1],b[0]-a[0],0.])?);
                }
                result.push(cell);
            }
        }
    }
    Ok(result)
}
fn component(template: &RetainedUnaryClip, input: &LogicalRetainedValue,
    evidence: FiniteClipPlane) -> Result<RetainedPlanOperation> {
    let mut clip = template.clone();
    clip.mode = RetainedClipMode::Intersection;
    let f = nalgebra::Matrix4::from_column_slice(input.object_frame());
    super::proper_rigid(&f)?;
    let inverse = f.try_inverse().ok_or_else(|| refused("finite clip singular frame"))?;
    let s = template.source.length_unit_scale;
    let p = evidence.source_plane;
    let point = inverse * nalgebra::Vector4::new(s*p[0],s*p[1],s*p[2],1.);
    let normal = f.fixed_view::<3,3>(0,0).transpose()*nalgebra::Vector3::new(p[3],p[4],p[5]);
    clip.local_plane = [point.x,point.y,point.z,normal.x,normal.y,normal.z];
    crate::document::retained_plane::validate_plane(&clip.local_plane).map_err(refused)?;
    clip.input_frame = *input.object_frame();
    clip.finite = Some(evidence);
    operation(input.try_copy()?,clip)
}
pub(super) fn expand(half: &DecodedEntity, decoder: &mut EntityDecoder, input: &LogicalRetainedValue,
    mut template: RetainedUnaryClip) -> Result<Vec<RetainedPlanOperation>> {
    let boundary = super::finite_source::capture_finite_boundary(half,decoder,&template.source)?;
    // Finite base and enclosure must share the same strict captured frame.
    // The inherited plain-halfspace/default path remains unchanged.
    let base_frame = super::finite_frame::frame(&template.source)?;
    template.source_plane = [base_frame[(0,3)],base_frame[(1,3)],base_frame[(2,3)],
        base_frame[(0,2)],base_frame[(1,2)],base_frame[(2,2)]];
    let cells = domains(&boundary)?;
    let count = cells.iter().map(|cell| cell.len()+2).sum::<usize>();
    if count > crate::document::retained_lineage::MAX_OPERATIONS {
        return Err(refused("finite halfspace operation budget"));
    }
    crate::resource::charge(crate::resource::Cost { live_bytes: std::mem::size_of_val(&boundary) as u64,
        work: count as u64, ..Default::default() })?.retain();
    let boundary = Arc::new(boundary);
    let mut operations = Vec::new();
    crate::resource::reserve_headers(&mut operations, count)?.retain();
    let mut accumulated: Option<LogicalRetainedValue> = None;
    for (cell, planes) in cells.into_iter().enumerate() {
        let base = component(&template,input,FiniteClipPlane { boundary:boundary.clone(),cell,edge:None,
            source_plane:template.source_plane })?;
        let mut value = base.value().try_copy()?;
        operations.push(base);
        for (edge, source_plane) in planes.into_iter().enumerate() {
            let next = component(&template,&value,FiniteClipPlane { boundary:boundary.clone(),cell,
                edge:Some(edge),source_plane })?;
            value = next.value().try_copy()?;
            operations.push(next);
        }
        // H intersect (union C_i) = union (H intersect C_i).
        // H minus (union C_i) = (...(H minus C_0) minus C_1)... .
        // Never subtract an unbounded side wall directly from H.
        let combine = match (template.mode, accumulated.take()) {
            (RetainedClipMode::Intersection, None) => { accumulated=Some(value); continue; }
            (RetainedClipMode::Intersection, Some(previous)) =>
                super::boolean::boolean_operation([previous,value],BoolOp::Union)?,
            (RetainedClipMode::Difference, previous) =>
                super::boolean::boolean_operation([match previous {Some(v)=>v,None=>input.try_copy()?},value],BoolOp::Difference)?,
        };
        accumulated = Some(combine.value().try_copy()?);
        operations.push(combine);
    }
    crate::resource::check_current()?;
    Ok(operations)
}
