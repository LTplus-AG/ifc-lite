// SPDX-License-Identifier: MPL-2.0
//! Strict finite-domain frame from captured binary source coefficients.
use super::clip::{refused, RetainedPlaneCoefficients, RetainedPlaneSource};
use crate::Result;
use num_rational::BigRational;
use num_traits::{Signed, ToPrimitive, Zero};

type ExactVector = [BigRational; 3];
fn direction(raw: Option<&RetainedPlaneCoefficients>, default: [f64; 3]) -> Result<ExactVector> {
    if raw.is_some_and(|v| v.arity != 3) {
        return Err(refused("finite frame requires three direction ratios"));
    }
    let values = raw.map_or(default, |v| v.values);
    let mut result = std::array::from_fn(|_| BigRational::zero());
    for (target, value) in result.iter_mut().zip(values) {
        *target = BigRational::from_float(value).ok_or_else(|| refused("nonfinite finite frame direction"))?;
    }
    Ok(result)
}
fn cross(a: &ExactVector, b: &ExactVector) -> ExactVector {
    std::array::from_fn(|i| {
        let j = (i + 1) % 3; let k = (i + 2) % 3;
        &a[j] * &b[k] - &a[k] * &b[j]
    })
}
fn unit(raw: &ExactVector) -> Result<nalgebra::Vector3<f64>> {
    let scale = raw.iter().map(Signed::abs).max().ok_or_else(|| refused("missing finite frame axis"))?;
    if scale.is_zero() { return Err(refused("zero or parallel finite frame axes")); }
    let mut values = [0.; 3];
    for (target, value) in values.iter_mut().zip(raw) {
        *target = (value / &scale).to_f64().ok_or_else(|| refused("unrepresentable finite frame direction"))?;
    }
    let length = values[0].hypot(values[1]).hypot(values[2]);
    for (value, exact) in values.iter_mut().zip(raw) {
        *value /= length;
        // No epsilon snapping: an authored nonzero sign must survive both
        // conversion and normalization, otherwise refuse before admission.
        if !value.is_finite() || (*value == 0.) != exact.is_zero()
            || (!exact.is_zero() && value.is_sign_negative() != exact.is_negative()) {
            return Err(refused("finite frame normalization lost exact direction sign"));
        }
    }
    Ok(nalgebra::Vector3::from(values))
}
pub(super) fn frame(source: &RetainedPlaneSource) -> Result<nalgebra::Matrix4<f64>> {
    crate::resource::charge(crate::resource::Cost { work: 1, ..Default::default() })?.retain();
    let location = source.location.as_ref().ok_or_else(|| refused("finite frame location missing"))?;
    if location.arity != 3 || location.values.iter().any(|v| !v.is_finite()) {
        return Err(refused("invalid finite frame location"));
    }
    let z = direction(source.axis.as_ref(), [0., 0., 1.])?;
    let reference = direction(source.ref_direction.as_ref(), [1., 0., 0.])?;
    // Exact cross products before normalization avoid cancellation/underflow
    // inventing a parallel direction or reversing a small authored component.
    let y = cross(&z, &reference);
    let x = cross(&y, &z);
    let mut frame = nalgebra::Matrix4::identity();
    for (column, axis) in [unit(&x)?, unit(&y)?, unit(&z)?].iter().enumerate() {
        for row in 0..3 { frame[(row, column)] = axis[row]; }
    }
    for row in 0..3 { frame[(row, 3)] = location.values[row]; }
    super::proper_rigid(&frame)?;
    Ok(frame)
}
