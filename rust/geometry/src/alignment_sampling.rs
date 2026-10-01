// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Opt-in alignment samples: f64 absolute IFC Z-up metres, never renderer lines.
use crate::{locate_axis_curve, AlignmentCurve, Error, GeometryRouter, Result};
use ifc_lite_core::{
    build_entity_index, decode_ifc_string, extract_length_unit_scale, keyword_eq, EntityDecoder,
    EntityScanner, IfcType, ProjectUnits,
};
use serde::Serialize;

const MAX_OUTPUT_SAMPLES: usize = 1_000_000;
const MAX_DIAGNOSTICS: usize = 1_000;

/// Output bounds include both endpoints. Distance starts at the physical start,
/// irrespective of authored chainage; spacing is horizontal distance in metres.
#[derive(Debug, Clone, Copy)]
pub struct AlignmentSamplingOptions {
    pub spacing_m: f64,
    pub max_samples_per_axis: usize,
    pub max_total_samples: usize,
}
impl Default for AlignmentSamplingOptions {
    fn default() -> Self {
        Self {
            spacing_m: 1.0,
            max_samples_per_axis: 5_001,
            max_total_samples: 100_000,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AlignmentSamplingReport {
    pub axes: Vec<SampledAlignmentAxis>,
    pub diagnostics: Vec<AlignmentSamplingDiagnostic>,
    /// Number suppressed after the bounded diagnostic buffer filled.
    pub diagnostics_omitted: usize,
}
#[derive(Debug, Serialize)]
#[allow(non_snake_case)] // Public IFC EXPRESS attribute names are exact.
pub struct SampledAlignmentAxis {
    pub express_id: u32,
    pub GlobalId: Option<String>,
    pub Name: Option<String>,
    pub geometric_horizontal_length_m: f64,
    pub samples: Vec<AlignmentSample>,
}
#[derive(Debug, Serialize)]
pub struct AlignmentSample {
    pub geometric_horizontal_distance_m: f64,
    pub point: [f64; 3],
    pub tangent: [f64; 3],
}
#[derive(Debug, Serialize)]
pub struct AlignmentSamplingDiagnostic {
    pub express_id: Option<u32>,
    pub code: AlignmentSamplingDiagnosticCode,
    pub message: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AlignmentSamplingDiagnosticCode {
    UnitResolution,
    InvalidAxis,
    ApproximateCurve,
    AxisSampleLimit,
    TotalSampleLimit,
}
impl AlignmentSamplingReport {
    fn diagnostic(
        &mut self,
        id: Option<u32>,
        code: AlignmentSamplingDiagnosticCode,
        message: impl Into<String>,
    ) {
        if self.diagnostics.len() == MAX_DIAGNOSTICS {
            self.diagnostics_omitted = self.diagnostics_omitted.saturating_add(1);
            return;
        }
        self.diagnostics.push(AlignmentSamplingDiagnostic {
            express_id: id,
            code,
            message: message.into(),
        });
    }
}

/// Shared evaluated axis. Retains the canonical evaluator before renderer
/// conversion, so a future WASM consumer can request an f64 frame at any distance.
#[allow(non_snake_case)] // Public IFC EXPRESS attribute names are exact.
pub struct AlignmentAxis {
    pub express_id: u32,
    pub GlobalId: Option<String>,
    pub Name: Option<String>,
    pub approximate: bool,
    curve: AlignmentCurve,
    placement: [f64; 16],
    unit_scale: f64,
}
impl AlignmentAxis {
    /// Resolve one retained evaluator. Missing units, placement and directrix
    /// fail explicitly; no fallback identity, scale or truncated success.
    pub fn from_content(content: &str, express_id: u32) -> Result<Self> {
        let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
        let mut scanner = EntityScanner::new(content);
        let mut project = None;
        while let Some((id, name, _, _)) = scanner.next_entity() {
            if keyword_eq(name, "IFCPROJECT") {
                project = Some(id);
                break;
            }
        }
        let scale = resolve_scale(&mut decoder, project).ok_or_else(|| {
            Error::geometry(
                "No declared, resolvable LENGTHUNIT matching the canonical geometry scale",
            )
        })?;
        Self::from_decoder(express_id, &mut decoder, scale)
    }
    fn from_decoder(id: u32, decoder: &mut EntityDecoder, unit_scale: f64) -> Result<Self> {
        let entity = decoder.decode_by_id(id)?;
        if entity.ifc_type != IfcType::IfcAlignment {
            return Err(Error::geometry("Requested entity is not IfcAlignment"));
        }
        let directrix = locate_axis_curve(&entity, decoder)
            .ok_or_else(|| Error::geometry("No supported Axis or FootPrint directrix"))?;
        let approximate = matches!(
            directrix.ifc_type,
            IfcType::IfcGradientCurve | IfcType::IfcCompositeCurve
        );
        let curve = AlignmentCurve::parse_for_sampling(&directrix, decoder)?
            .ok_or_else(|| Error::geometry("Unsupported or incomplete directrix"))?;
        crate::alignment_sampling_placement::validate_placement(&entity, decoder)?;
        let approximate = approximate || curve.uses_approximation();
        let placement = GeometryRouter::with_scale(unit_scale)
            .resolve_scaled_placement_strict(&entity, decoder)?;
        let axis = Self {
            curve,
            placement,
            unit_scale,
            express_id: id,
            GlobalId: entity
                .get_string(0)
                .map(|s| decode_ifc_string(s).into_owned()),
            Name: entity
                .get_string(2)
                .map(|s| decode_ifc_string(s).into_owned()),
            approximate,
        };
        if !axis.length_m().is_finite() || axis.length_m() <= 0.0 {
            return Err(Error::geometry("Axis length must be finite and positive"));
        }
        Ok(axis)
    }
    pub fn length_m(&self) -> f64 {
        self.curve.horizontal_length() * self.unit_scale
    }
    pub fn evaluate(&self, distance_m: f64) -> Result<AlignmentSample> {
        if !distance_m.is_finite() || distance_m < 0.0 || distance_m > self.length_m() {
            return Err(Error::geometry(
                "Distance must be within the geometric horizontal length",
            ));
        }
        let frame = self.curve.evaluate(distance_m / self.unit_scale);
        let p = frame.origin * self.unit_scale;
        let t = frame.tangent;
        let m = &self.placement;
        let point = [
            m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
            m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
        ];
        let mut tangent = [
            m[0] * t.x + m[4] * t.y + m[8] * t.z,
            m[1] * t.x + m[5] * t.y + m[9] * t.z,
            m[2] * t.x + m[6] * t.y + m[10] * t.z,
        ];
        let norm = tangent.iter().map(|v| v * v).sum::<f64>().sqrt();
        if !point.iter().chain(tangent.iter()).all(|v| v.is_finite())
            || !norm.is_finite()
            || norm <= 0.0
        {
            return Err(Error::geometry(format!(
                "Nonfinite or degenerate frame at geometric distance {distance_m} m"
            )));
        }
        tangent.iter_mut().for_each(|v| *v /= norm);
        Ok(AlignmentSample {
            geometric_horizontal_distance_m: distance_m,
            point,
            tangent,
        })
    }
}

fn resolve_scale(decoder: &mut EntityDecoder, project: Option<u32>) -> Option<f64> {
    let id = project?;
    let declared = ProjectUnits::resolve(decoder, id)
        .resolved_for_unit_type("LENGTHUNIT")?
        .si_scale;
    let geometry = extract_length_unit_scale(decoder, id).ok()?;
    (declared.is_finite()
        && declared > 0.0
        && geometry.is_finite()
        && geometry > 0.0
        && (declared - geometry).abs() <= 1e-12 * declared.abs())
    .then_some(geometry)
}

/// Sample every resolvable alignment in source order. Failed axes are reported;
/// no identity-placement or implicit-metre fallback is permitted. When bounds
/// coarsen spacing both endpoints remain; exhausted total budgets omit later
/// axes with explicit diagnostics. The cap applies to emitted samples, not IFC
/// parsing memory (which is bounded by input size and canonical refwalk guards).
pub fn sample_alignment_axes(
    content: &str,
    options: AlignmentSamplingOptions,
) -> Result<AlignmentSamplingReport> {
    if !options.spacing_m.is_finite()
        || options.spacing_m <= 0.0
        || options.max_samples_per_axis < 2
        || options.max_total_samples < 2
        || options.max_samples_per_axis > MAX_OUTPUT_SAMPLES
        || options.max_total_samples > MAX_OUTPUT_SAMPLES
    {
        return Err(Error::geometry(
            "spacing_m must be finite and positive; sample bounds must be 2..=1000000",
        ));
    }
    let mut report = AlignmentSamplingReport {
        axes: vec![],
        diagnostics: vec![],
        diagnostics_omitted: 0,
    };
    let mut scanner = EntityScanner::new(content);
    let mut project = None;
    let mut ids = Vec::new();
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if keyword_eq(name, "IFCPROJECT") && project.is_none() {
            project = Some(id);
        }
        if keyword_eq(name, "IFCALIGNMENT") {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Ok(report);
    }
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    let scale = resolve_scale(&mut decoder, project);
    let Some(unit_scale) = scale else {
        report.diagnostic(
            None,
            AlignmentSamplingDiagnosticCode::UnitResolution,
            "No declared, resolvable LENGTHUNIT matching the canonical geometry scale",
        );
        return Ok(report);
    };
    let mut evaluated = 0;
    for id in ids {
        let remaining = options.max_total_samples - evaluated;
        if remaining < 2 {
            report.diagnostic(
                Some(id),
                AlignmentSamplingDiagnosticCode::TotalSampleLimit,
                "Axis omitted: fewer than two samples remain in total budget",
            );
            continue;
        }
        let result = (|| -> Result<(SampledAlignmentAxis, bool, bool, bool)> {
            let axis = AlignmentAxis::from_decoder(id, &mut decoder, unit_scale)?;
            let approximate = axis.approximate;
            let length = axis.length_m();
            // Compare in f64 before casting so even a subnormal spacing cannot
            // overflow an integer or allocate unbounded output.
            let requested_segments = (length / options.spacing_m).ceil().max(1.0);
            let cap = options.max_samples_per_axis.min(remaining);
            let segments = requested_segments.min((cap - 1) as f64) as usize;
            let capped = requested_segments > segments as f64;
            let mut samples = Vec::with_capacity(segments + 1);
            for i in 0..=segments {
                let distance = if i == segments {
                    length
                } else if capped {
                    length * (i as f64 / segments as f64)
                } else {
                    i as f64 * options.spacing_m
                };
                // Failed axes still consume frame work: a late invalid frame
                // must not reset the model-wide sampling budget.
                evaluated += 1;
                samples.push(axis.evaluate(distance)?);
            }
            Ok((
                SampledAlignmentAxis {
                    express_id: id,
                    GlobalId: axis.GlobalId,
                    Name: axis.Name,
                    geometric_horizontal_length_m: length,
                    samples,
                },
                approximate,
                requested_segments >= options.max_samples_per_axis as f64
                    && options.max_samples_per_axis <= remaining,
                requested_segments >= remaining as f64 && remaining <= options.max_samples_per_axis,
            ))
        })();
        match result {
            Ok((axis, approximate, axis_capped, total_capped)) => {
                if approximate {
                    report.diagnostic(Some(id), AlignmentSamplingDiagnosticCode::ApproximateCurve, "Uses canonical curve approximation: medium-quality tessellation or approximated transition subtype");
                }
                if axis_capped {
                    report.diagnostic(
                        Some(id),
                        AlignmentSamplingDiagnosticCode::AxisSampleLimit,
                        "Per-axis sample bound coarsened spacing; endpoints retained",
                    );
                }
                if total_capped {
                    report.diagnostic(
                        Some(id),
                        AlignmentSamplingDiagnosticCode::TotalSampleLimit,
                        "Total sample bound coarsened spacing; endpoints retained",
                    );
                }
                report.axes.push(axis);
            }
            Err(error) => report.diagnostic(
                Some(id),
                AlignmentSamplingDiagnosticCode::InvalidAxis,
                error.to_string(),
            ),
        }
    }
    Ok(report)
}

#[cfg(test)]
#[path = "alignment_sampling_tests.rs"]
mod tests;
