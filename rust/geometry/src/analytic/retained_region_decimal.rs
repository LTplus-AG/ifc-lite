// SPDX-License-Identifier: MPL-2.0
//! Retained-only authored-decimal authority. No change to ordinary decoding.
//! A checked i128 grid of 10^-18 raw units establishes exact equality/order,
//! not approximate coordinates. Unsupported precision/range explicitly refuses.
//! Every coordinate comparison used by cancellation must agree with this order.
use super::{AnalyticBoundarySource, AnalyticCurveSegment, AnalyticExtrusion,
    AnalyticProfileLoop, AnalyticStatus, SourceValue};
use ifc_lite_core::EntityDecoder;

const MAX_BYTES: usize = 65_536;
const MAX_VALUES: usize = 387; // 129 source XY/XYZ points
const RANGE: &str = "retained region authored decimal range unsupported";

/// Private immutable token witnesses retained with the sealed certificate.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct DecimalAuthority(Vec<(u32, Vec<u8>)>);
impl DecimalAuthority {
    pub(super) fn record(&self, id: u32) -> Option<&[u8]> {
        self.0.iter().find(|(record_id, _)| *record_id == id).map(|(_, bytes)| bytes.as_slice())
    }
}

pub(super) fn prove(source: &AnalyticBoundarySource, original: &AnalyticProfileLoop,
    decoder: &mut EntityDecoder) -> Result<DecimalAuthority, String> {
    if original.segments.len() > 128 { return Err("decimal edge budget exceeded".into()); }
    if source.records.len() > 132 { return Err("decimal source record budget exceeded".into()); }
    // Covers token copies, scalar scratch and all pairwise comparisons before
    // traversal/allocation. The fixed limits below also apply without an account.
    charge(MAX_BYTES as u64 * 4, 1_000_000)?;
    let mut remaining = MAX_BYTES;
    let mut scalars = Vec::new();
    let mut records = Vec::new();
    for record in source.records.values() {
        let key = match record.ifc_type_name.as_str() {
            "IfcCartesianPoint" => "Coordinates",
            "IfcCartesianPointList2D" => "CoordList",
            _ => continue,
        };
        let raw = decoder.get_raw_bytes(record.id).ok_or("missing decimal source bytes")?;
        remaining = remaining.checked_sub(raw.len()).ok_or("decimal source byte budget exceeded")?;
        let start = raw.iter().position(|b| *b == b'(').ok_or("missing decimal attributes")?;
        let header: Vec<u8> = raw[..start].iter().copied().filter(|b| !b.is_ascii_whitespace()).collect();
        if !header.eq_ignore_ascii_case(format!("#{}={}", record.id, record.ifc_type_name).as_bytes()) {
            return Err("decimal source identity mismatch".into());
        }
        let mut cursor = Cursor { bytes: &raw[start+1..], at: 0 };
        cursor.value(record.attributes.get(key).ok_or("missing decimal coordinates")?, 0, &mut scalars)?;
        cursor.space();
        if !matches!(cursor.bytes.get(cursor.at), Some(b',' | b')')) {
            return Err("decimal source attribute mismatch".into());
        }
        records.push((record.id, raw.to_vec()));
    }
    // Include the implicit XY zero as well: a nonzero authored Z that rounded
    // to zero must never pass the regularizer's plane predicate.
    scalars.push((0., 0));
    for &(a, exact_a) in &scalars {
        for &(b, exact_b) in &scalars {
            if (a == b) != (exact_a == exact_b) || (a < b) != (exact_a < exact_b) {
                return Err("retained region authored decimal predicate mismatch".into());
            }
        }
    }
    for segment in &original.segments {
        let AnalyticCurveSegment::Line { start, end } = segment else { return Err("decimal proof requires lines".into()); };
        for value in start.iter().chain(end) {
            if !scalars.iter().any(|(decoded, _)| decoded == value) {
                return Err("interpreted coordinate lacks decimal authority".into());
            }
        }
    }
    Ok(DecimalAuthority(records))
}

struct Cursor<'a> { bytes: &'a [u8], at: usize }
impl Cursor<'_> {
    fn space(&mut self) {
        while self.bytes.get(self.at).is_some_and(u8::is_ascii_whitespace) { self.at += 1; }
    }
    fn take(&mut self, expected: u8) -> Result<(), String> {
        self.space();
        if self.bytes.get(self.at) != Some(&expected) { return Err("decimal source structure mismatch".into()); }
        self.at += 1;
        Ok(())
    }
    fn value(&mut self, value: &SourceValue, depth: usize, out: &mut Vec<(f64, i128)>) -> Result<(), String> {
        if depth > 2 { return Err("decimal coordinate depth exceeded".into()); }
        if let SourceValue::List(values) = value {
            if values.len() > 129 { return Err("decimal coordinate count exceeded".into()); }
            self.take(b'(')?;
            for (i, value) in values.iter().enumerate() {
                if i != 0 { self.take(b',')?; }
                self.value(value, depth+1, out)?;
            }
            return self.take(b')');
        }
        if out.len() >= MAX_VALUES { return Err("decimal coordinate count exceeded".into()); }
        self.space();
        let start = self.at;
        while self.bytes.get(self.at).is_some_and(|b| b.is_ascii_digit() || matches!(b, b'.'|b'+'|b'-'|b'E'|b'e')) {
            self.at += 1;
            if self.at-start > 64 { return Err(RANGE.into()); }
        }
        let token = std::str::from_utf8(&self.bytes[start..self.at]).map_err(|_| RANGE)?;
        let decoded = match value {
            SourceValue::Real(v) => *v,
            SourceValue::Integer(v) => *v as f64,
            _ => return Err("decimal source requires numeric coordinates".into()),
        };
        if !decoded.is_finite() || token.parse::<f64>().map_err(|_| RANGE)? != decoded {
            return Err("decimal source decoded mismatch".into());
        }
        out.push((decoded, decimal(token)?));
        Ok(())
    }
}

fn decimal(token: &str) -> Result<i128, String> {
    let (mantissa, exponent) = match token.split_once(['e', 'E']) {
        Some((m, e)) => (m, e.parse::<i32>().map_err(|_| RANGE)?),
        None => (token, 0),
    };
    if !(-18..=18).contains(&exponent) { return Err(RANGE.into()); }
    let negative = mantissa.starts_with('-');
    let mantissa = mantissa.strip_prefix(['-', '+']).unwrap_or(mantissa);
    let mut coefficient = 0i128;
    let mut fraction = 0i32;
    let mut dot = false;
    let mut digits = 0;
    for b in mantissa.bytes() {
        if b == b'.' && !dot { dot = true; continue; }
        if !b.is_ascii_digit() { return Err(RANGE.into()); }
        digits += 1;
        if digits > 36 { return Err(RANGE.into()); }
        coefficient = coefficient.checked_mul(10).and_then(|v| v.checked_add((b-b'0') as i128)).ok_or(RANGE)?;
        if dot { fraction += 1; }
    }
    let scale = 18 + exponent - fraction;
    if digits == 0 || !(0..=36).contains(&scale) { return Err(RANGE.into()); }
    let result = coefficient.checked_mul(10i128.pow(scale as u32)).ok_or(RANGE)?;
    Ok(if negative { -result } else { result })
}

fn charge(bytes: u64, work: u64) -> Result<(), String> {
    crate::resource::charge(crate::resource::Cost { work, live_bytes: bytes, copy_bytes: bytes,
        ..Default::default() }).map_err(|e| e.to_string())?.retain();
    Ok(())
}

pub(super) fn capture_profile(authored: &mut AnalyticExtrusion, decoder: &mut EntityDecoder) -> Result<(), String> {
    let id = authored.swept_area_id.ok_or("missing profile source id")?;
    let raw = decoder.get_raw_bytes(id).ok_or("missing profile source bytes")?;
    if raw.len() > 16_384 { return Err("profile source byte budget exceeded".into()); }
    // Precharge before the decoder clone and SourceCapture's owned record copy.
    charge(131_072, 16_384)?;
    let entity = decoder.decode_by_id(id).map_err(|e| e.to_string())?;
    if entity.attributes.len() != 3 { return Err("invalid profile source attributes".into()); }
    let mut capture = super::source::SourceCapture::enabled();
    capture.record(&entity, decoder);
    let captured = capture.finish(id, decoder.plane_angle_to_radians());
    if captured.capture_status != AnalyticStatus::Complete { return Err("incomplete profile source capture".into()); }
    let source = authored.source.as_mut().ok_or("missing solid source capture")?;
    if source.capture_status != AnalyticStatus::Complete { return Err("incomplete solid source capture".into()); }
    source.records.extend(captured.records);
    Ok(())
}
