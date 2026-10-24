// SPDX-License-Identifier: MPL-2.0
//! Checked 10^-18 raw-unit grid, following #3641's retained_region_decimal.
//! Fixed i128 storage: no big integers, rounding, dynamic token copies or floats.
use super::{resource, RetainedExecutionError};
use super::removal_source::refused;
pub(super) const ONE: i128 = 1_000_000_000_000_000_000;
pub(super) fn charge(work: u64) -> Result<(), RetainedExecutionError> {
    resource::charge(resource::Cost { work, ..Default::default() })
        .map_err(RetainedExecutionError::Stopped)?.retain();
    Ok(())
}
pub(super) fn decimal(bytes: &[u8]) -> Result<i128, RetainedExecutionError> {
    // Before scanning or interpreting even an overlong token. No allocation.
    charge(64)?;
    if bytes.len() > 64 || ifc_lite_core::parser::step_numeric_literal_len(bytes) != Some(bytes.len()) {
        return Err(refused());
    }
    let token = std::str::from_utf8(bytes).map_err(|_| refused())?;
    let (mantissa, exponent) = match token.split_once(['e','E']) {
        Some((m,e)) => (m,e.parse::<i32>().map_err(|_| refused())?),
        None => (token,0),
    };
    if !(-18..=18).contains(&exponent) { return Err(refused()); }
    let negative = mantissa.starts_with('-');
    let mantissa = mantissa.strip_prefix(['-','+']).unwrap_or(mantissa);
    let (mut coefficient, mut fraction, mut digits, mut dot) = (0i128,0i32,0,false);
    for b in mantissa.bytes() {
        if b == b'.' && !dot { dot = true; continue; }
        if !b.is_ascii_digit() { return Err(refused()); }
        digits += 1;
        if digits > 36 { return Err(refused()); }
        coefficient = coefficient.checked_mul(10).and_then(|v| v.checked_add((b-b'0') as i128)).ok_or_else(refused)?;
        if dot { fraction += 1; }
    }
    let scale = 18 + exponent - fraction;
    if digits == 0 || !(0..=36).contains(&scale) { return Err(refused()); }
    let value = coefficient.checked_mul(10i128.pow(scale as u32)).ok_or_else(refused)?;
    Ok(if negative { -value } else { value })
}
pub(super) fn add(a: i128, b: i128) -> Result<i128, RetainedExecutionError> {
    a.checked_add(b).ok_or_else(refused)
}
/// Twice the endpoint, retaining exact half-dimensions without a smaller grid.
pub(super) fn endpoint(origin: i128, centre: i128, extent: i128) -> Result<i128, RetainedExecutionError> {
    add(add(origin, centre)?.checked_mul(2).ok_or_else(refused)?, extent)
}
