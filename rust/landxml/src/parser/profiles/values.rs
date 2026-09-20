/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::super::Code;
use crate::xml::{attr, error, required, Attributes, Result};

pub(super) fn finite_attr(attributes: &Attributes, name: &str, context: &str) -> Result<f64> {
    required(attributes, name, context)?
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                format!("{context} has invalid {name}"),
            )
        })
}

pub(super) fn optional_finite_attr(
    attributes: &Attributes,
    name: &str,
    context: &str,
) -> Result<Option<f64>> {
    attr(attributes, name)
        .map(|value| {
            value
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .ok_or_else(|| {
                    error(
                        Code::InvalidSemantic,
                        format!("{context} has invalid {name}"),
                    )
                })
        })
        .transpose()
}

pub(super) fn station_elevation(text: &str, context: &str) -> Result<(f64, Option<f64>)> {
    let mut values = text.split_ascii_whitespace();
    let station = finite(values.next(), context, "station/offset")?;
    let elevation = values
        .next()
        .map(|value| finite(Some(value), context, "elevation"))
        .transpose()?;
    if values.next().is_some() {
        return Err(error(
            Code::InvalidSemantic,
            format!("{context} has more than two coordinates"),
        ));
    }
    Ok((station, elevation))
}

pub(super) fn station_elevations(text: &str, context: &str) -> Result<Vec<(f64, Option<f64>)>> {
    let mut values = text.split_ascii_whitespace();
    let mut result = Vec::new();
    while let Some(station) = values.next() {
        result.push((
            finite(Some(station), context, "station/offset")?,
            values
                .next()
                .map(|value| finite(Some(value), context, "elevation"))
                .transpose()?,
        ));
    }
    if result.is_empty() {
        return Err(error(Code::InvalidSemantic, format!("{context} is empty")));
    }
    Ok(result)
}

/// Count pairs before allocating their parsed representation.  The parser has
/// historically retained a trailing missing elevation as a capability gap, so
/// an odd coordinate count deliberately reserves the final partial pair too.
pub(super) fn station_elevation_count(text: &str, context: &str) -> Result<usize> {
    let values = text.split_ascii_whitespace().count();
    if values == 0 {
        return Err(error(Code::InvalidSemantic, format!("{context} is empty")));
    }
    Ok(values.div_ceil(2))
}

pub(super) fn references_attr(attributes: &Attributes, name: &str) -> Vec<String> {
    attr(attributes, name)
        .map(|value| value.split_ascii_whitespace().map(str::to_owned).collect())
        .unwrap_or_default()
}

fn finite(value: Option<&str>, context: &str, coordinate: &str) -> Result<f64> {
    value
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .ok_or_else(|| {
            error(
                Code::InvalidSemantic,
                format!("{context} has invalid or missing {coordinate}"),
            )
        })
}
