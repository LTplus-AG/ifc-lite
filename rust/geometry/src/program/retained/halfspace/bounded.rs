// SPDX-License-Identifier: MPL-2.0
//! One analytic prism for Prism(PolygonalBoundary, Position.Z) ∩ BaseSurface.
//! #7955: no exact heuristic, sampled boundary, or unbounded-plane fallback.
#[cfg(not(feature = "retained-runtime"))]
pub(super) fn step(ctx: super::Context<'_, '_>) -> crate::Result<super::CutterStep> { super::refuse(ctx) }

#[cfg(feature = "retained-runtime")]
use {
    super::{Context, CutterStep, FailureSite, OriginCause},
    super::super::cutter,
    crate::analytic::{analytic_boundary_loop, AnalyticCurveSegment},
    crate::document::{PrismLoop, PrismRole, PrismSegment, RetainedPrism, RetainedRefusal, retained_frames},
    crate::math::{mat4::col_major_array, tol::RETAINED_RIGID_DOT_EPS},
    ifc_lite_core::IfcType,
    nalgebra::{Matrix4, Point3, Vector3},
};

#[cfg(feature = "retained-runtime")]
pub(super) fn step(mut ctx: Context<'_, '_>) -> crate::Result<CutterStep> {
    let result = lower(&mut ctx);
    result.map_err(|error| {
        if !matches!(error, crate::Error::ProgramStopped(_)) && ctx.failure.origin().is_none() {
            ctx.failure.record(FailureSite::BooleanSecondOperand, Some(ctx.second.id),
                OriginCause::Recipe(RetainedRefusal::InvalidSource("invalid bounded halfspace source")));
        }
        error
    })
}

#[cfg(feature = "retained-runtime")]
fn unsupported(ctx: &Context<'_, '_>, reason: &str) -> crate::Error {
    let refusal = RetainedRefusal::UnsupportedSource(reason.into());
    let error = crate::Error::geometry(refusal.to_string());
    ctx.failure.record(FailureSite::BooleanSecondOperand, Some(ctx.second.id), OriginCause::Recipe(refusal));
    error
}

#[cfg(feature = "retained-runtime")]
fn lower(ctx: &mut Context<'_, '_>) -> crate::Result<CutterStep> {
    match ctx.operator {
        crate::BoolOp::Difference => {},
        crate::BoolOp::Union => return Err(unsupported(ctx, "halfspace_union")),
        crate::BoolOp::Intersection => return Err(unsupported(ctx, "halfspace_intersection")),
        _ => return Err(unsupported(ctx, "halfspace_operator")),
    }
    if ctx.second.get_bool(1).is_none() { return Err(crate::Error::geometry("missing AgreementFlag")); }
    let (p, r) = super::plane_source::lower(ctx.host, ctx.second, ctx.decoder)?;
    let (p, r) = (Vector3::from(p), Vector3::from(r));
    let id = ctx.second.get_ref(2).ok_or_else(|| crate::Error::geometry("missing PBHS Position"))?;
    let position = ctx.decoder.decode_by_id(id)?;
    if position.ifc_type != IfcType::IfcAxis2Placement3D {
        return Err(crate::Error::geometry("PBHS Position must be IfcAxis2Placement3D"));
    }
    let mut frame = crate::placement::Axis2Placement::read_3d(&position, ctx.decoder)?.matrix();
    for i in 0..3 { frame[(i, 3)] *= ctx.host.length_unit_scale; }
    let relative = retained_frames::relative(*ctx.host.object_frame(), col_major_array(&frame))
        .map_err(crate::Error::geometry)?;
    let frame = Matrix4::from_column_slice(&relative);
    let z = Vector3::new(relative[8], relative[9], relative[10]);
    let dot = r.dot(&z);
    // Refuse before decoding PolygonalBoundary, including an invalid reference.
    if dot.abs() < RETAINED_RIGID_DOT_EPS {
        return Err(unsupported(ctx, "bounded_halfspace_parallel"));
    }
    let boundary_id = ctx.second.get_ref(3).ok_or_else(|| crate::Error::geometry("missing PolygonalBoundary"))?;
    let boundary = ctx.decoder.decode_by_id(boundary_id)?;
    if !boundary.ifc_type.is_subtype_of(IfcType::IfcBoundedCurve) {
        return Err(crate::Error::geometry("PolygonalBoundary must be IfcBoundedCurve"));
    }
    let boundary = analytic_boundary_loop(boundary_id, ctx.decoder)?;
    if boundary.segments.len() > 256 { return Err(unsupported(ctx, "bounded_halfspace_vertices")); }
    if boundary.segments.iter().any(|s| matches!(s, AnalyticCurveSegment::Arc { .. }))
        && (dot.abs() - 1.).abs() > RETAINED_RIGID_DOT_EPS {
        return Err(unsupported(ctx, "bounded_halfspace_oblique_arc"));
    }
    let bounds = ctx.host.bounds.filter(|b| b.valid()).ok_or_else(|| unsupported(ctx, "unbounded_host"))?;
    let h = bounds.corners().iter().map(|c| r.dot(&(Vector3::from(*c) - p))).fold(f64::NEG_INFINITY, f64::max);
    if h <= 0. { return Ok(CutterStep::Skip); }
    let diagonal = Vector3::new(bounds.0[3] - bounds.0[0], bounds.0[4] - bounds.0[1], bounds.0[5] - bounds.0[2]).norm();
    let margin = cutter::MARGIN_MIN_M.max(cutter::MARGIN_DIAGONAL * diagonal);
    let (u, v) = cutter::plane_axes(r);
    let direction = z * dot.signum();
    crate::resource::charge(crate::resource::Cost {
        live_bytes: (boundary.segments.len() * (std::mem::size_of::<PrismSegment>() + 104)) as u64,
        ..Default::default()
    })?.retain();
    let projection = Projection { frame, scale: ctx.host.length_unit_scale, p, r, z, u, v, dot };
    let segments = boundary.segments.iter().map(|s| projection.segment(s)).collect();
    let prism = RetainedPrism {
        source_id: ctx.second.id, role: PrismRole::BoundedHalfSpace,
        frame: col_major_array(&Matrix4::from_columns(&[u.push(0.), v.push(0.), r.push(0.), p.push(1.)])),
        direction: [u.dot(&direction), v.dot(&direction), r.dot(&direction)],
        depth: (h + margin) / dot.abs(), loops: vec![PrismLoop { outer: true, segments }],
    };
    cutter::prism_operation(ctx.host, prism).map(CutterStep::Cutter)
}

#[cfg(feature = "retained-runtime")]
struct Projection {
    frame: Matrix4<f64>, scale: f64, p: Vector3<f64>, r: Vector3<f64>,
    z: Vector3<f64>, u: Vector3<f64>, v: Vector3<f64>, dot: f64,
}
#[cfg(feature = "retained-runtime")]
impl Projection {
    fn point(&self, source: [f64; 3]) -> [f64; 2] {
        let q = self.frame.transform_point(&Point3::from(Vector3::from(source) * self.scale)).coords;
        let projected = q - self.z * (self.r.dot(&(q - self.p)) / self.dot);
        [self.u.dot(&(projected - self.p)), self.v.dot(&(projected - self.p))]
    }
    fn segment(&self, segment: &AnalyticCurveSegment) -> PrismSegment {
        match *segment {
            AnalyticCurveSegment::Line { start, end } => PrismSegment::Line { start: self.point(start), end: self.point(end) },
            AnalyticCurveSegment::Arc { center, normal, x_axis, radius, start_angle, sweep_angle } => {
                let center2 = self.point(center);
                let radius = radius * self.scale;
                if sweep_angle.abs() >= std::f64::consts::TAU - crate::math::tol::RETAINED_ARC_INTERVAL_EPS_RAD {
                    return PrismSegment::Circle { center: center2, radius };
                }
                let x = Vector3::from(x_axis);
                let y = Vector3::from(normal).cross(&x);
                let radial = self.frame.transform_vector(&(x * start_angle.cos() + y * start_angle.sin()));
                let start_angle = self.v.dot(&radial).atan2(self.u.dot(&radial));
                let sense = self.r.dot(&self.frame.transform_vector(&Vector3::from(normal))).signum();
                PrismSegment::Arc { center: center2, radius, start_angle, sweep_angle: sweep_angle * sense }
            }
        }
    }
}
