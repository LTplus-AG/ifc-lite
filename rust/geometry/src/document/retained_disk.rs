// SPDX-License-Identifier: MPL-2.0
//! Exact coefficient conversion at the numerical edge; originals stay in recipe.
use super::{retained_sweep::{RegionQualification, SweepPayload}, RetainedRefusal, RetainedSweptDisk};
use crate::analytic::{AnalyticCurveSegment, AnalyticStatus, OwnedDirectrix, OwnedRationalCurve};

pub(super) fn lower(recipe: &RetainedSweptDisk) -> Result<SweepPayload, RetainedRefusal> {
    let original = recipe.source.source.as_ref().ok_or(RetainedRefusal::OriginalTrimConventionUnavailable)?;
    if !matches!(original.capture_status, AnalyticStatus::Complete) || original.root_entity_id != recipe.solid_id
        || !original.records.contains_key(&recipe.solid_id) {
        return Err(RetainedRefusal::UnsupportedSource("incomplete swept disk source capture".into()));
    }
    let units = recipe.length_unit_scale;
    let radius = recipe.source.radius * units;
    if !units.is_finite() || units <= 0. || !radius.is_finite() || radius <= 1e-12 || radius > 1e9 {
        return invalid("invalid retained disk units/radius");
    }
    if recipe.source.inner_radius.is_some() {
        return Err(RetainedRefusal::UnsupportedSource("hollow swept disks are not supported by this numerical route".into()));
    }
    let path = match recipe.source.owned_directrix.as_ref() {
        Some(OwnedDirectrix::Rational(path)) => path.clone(),
        Some(OwnedDirectrix::Segments(segments)) => exact_path(segments, recipe.source.directrix_id)?,
        None => return Err(RetainedRefusal::UnsupportedSource("swept disk directrix has no complete exact coefficient route".into())),
    };
    validate(&path)?;
    let anchor = path.control_points[0];
    let mut bytes = Vec::new();
    for value in [2u32, 1, 1, 0] { bytes.extend(value.to_le_bytes()); }
    for value in [radius, 0.] { scalar(&mut bytes, value)?; }
    for value in [4, 0, path.degree, path.control_points.len() as u32, path.knots.len() as u32, 0] {
        bytes.extend(value.to_le_bytes());
    }
    for value in path.parameter_range { scalar(&mut bytes, value)?; }
    for (point, weight) in path.control_points.iter().zip(&path.weights) {
        for axis in 0..3 { scalar(&mut bytes, (point[axis]-anchor[axis])*units)?; }
        scalar(&mut bytes, *weight)?;
    }
    for (knot, count) in path.knots.iter().zip(&path.multiplicities) {
        scalar(&mut bytes, *knot)?; bytes.extend(count.to_le_bytes()); bytes.extend(0u32.to_le_bytes());
    }
    if bytes.len() > 1_048_576 { return invalid("disk recipe exceeds bounded upload"); }
    let mut forward = [0.;16]; let mut inverse = [0.;16];
    for i in 0..3 {
        forward[i*4+i] = 1./units; forward[12+i] = anchor[i];
        inverse[i*4+i] = units; inverse[12+i] = -anchor[i]*units;
    }
    forward[15]=1.; inverse[15]=1.;
    if forward.iter().chain(&inverse).any(|v| !v.is_finite()) { return invalid("disk evaluation frame overflows"); }
    Ok(SweepPayload { format:2, bytes, loops:1, segments:1, qualification:RegionQualification::RationalDisk,
        source_from_evaluation:forward, evaluation_from_source:inverse })
}
fn scalar(bytes: &mut Vec<u8>, v: f64) -> Result<(), RetainedRefusal> {
    if !v.is_finite() || v.abs()>1e9 { return invalid("disk coefficient outside local numerical domain"); }
    bytes.extend(v.to_le_bytes()); Ok(())
}
fn validate(path: &OwnedRationalCurve) -> Result<(), RetainedRefusal> {
    let n=path.control_points.len(); let degree=path.degree as usize;
    if !(1..=32).contains(&degree) || n<=degree || n>8192 || path.weights.len()!=n
        || path.knots.len()<2 || path.knots.len()>8192 || path.multiplicities.len()!=path.knots.len()
        || path.control_points.iter().flatten().any(|v| !v.is_finite())
        || path.weights.iter().any(|v| !v.is_finite() || *v<=0.)
        || path.knots.iter().any(|v| !v.is_finite()) || path.knots.windows(2).any(|p| p[0]>=p[1]) {
        return invalid("invalid exact rational coefficients");
    }
    let mut sum=0usize;
    for (i, count) in path.multiplicities.iter().enumerate() {
        let end=i==0 || i+1==path.knots.len();
        if (end && *count as usize!=degree+1) || (!end && (*count==0 || *count as usize>degree)) {
            return invalid("unsupported rational multiplicities");
        }
        sum+=*count as usize;
    }
    let [start,end]=path.parameter_range;
    if sum!=n+degree+1 || !start.is_finite() || !end.is_finite() || start>=end
        || start<path.knots[0] || end>*path.knots.last().expect("nonempty checked") {
        return invalid("invalid rational active domain");
    }
    Ok(())
}
fn exact_path(segments: &[AnalyticCurveSegment], id:u32) -> Result<OwnedRationalCurve, RetainedRefusal> {
    let (degree, controls, weights, knots, multiplicities)=match segments {
        [AnalyticCurveSegment::Line { start,end }] => (1,vec![*start,*end],vec![1.,1.],vec![0.,1.],vec![2,2]),
        [AnalyticCurveSegment::Arc { center,normal,x_axis,radius,start_angle,sweep_angle }]
            if sweep_angle.abs()>1e-12 && sweep_angle.abs()<std::f64::consts::TAU-1e-12 => {
            let count=(sweep_angle.abs()/std::f64::consts::FRAC_PI_2).ceil() as usize;
            let y=[normal[1]*x_axis[2]-normal[2]*x_axis[1],normal[2]*x_axis[0]-normal[0]*x_axis[2],normal[0]*x_axis[1]-normal[1]*x_axis[0]];
            let point=|angle:f64, divisor:f64| std::array::from_fn(|i| center[i]+radius*(x_axis[i]*angle.cos()+y[i]*angle.sin())/divisor);
            let delta=sweep_angle/count as f64; let w=(delta/2.).cos();
            let mut controls=vec![point(*start_angle,1.)]; let mut weights=vec![1.];
            for i in 0..count {
                controls.push(point(start_angle+delta*(i as f64+0.5),w)); weights.push(w);
                controls.push(point(start_angle+delta*(i as f64+1.),1.)); weights.push(1.);
            }
            let knots=(0..=count).map(|i| i as f64).collect();
            let mult=(0..=count).map(|i| if i==0 || i==count {3} else {2}).collect();
            (2,controls,weights,knots,mult)
        }
        _ => return Err(RetainedRefusal::UnsupportedSource("closed or multi-segment disk directrix requires an additional qualified route".into())),
    };
    let end=*knots.last().expect("constructed nonempty knots");
    // This exact conic conversion is DERIVED evaluation data. Source circles,
    // angles, trim selectors and line Magnitude remain unchanged in recipe.
    Ok(OwnedRationalCurve { source_entity_id:id,degree,control_points:controls,weights,knots,
        multiplicities,expanded_knots:Vec::new(),parameter_range:[0.,end] })
}
fn invalid<T>(message:&'static str)->Result<T,RetainedRefusal>{Err(RetainedRefusal::InvalidSource(message))}

#[cfg(test)]
#[path="retained_disk_tests.rs"]
mod tests;
