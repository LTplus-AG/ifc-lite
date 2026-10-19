// SPDX-License-Identifier: MPL-2.0
//! Additive fixed-rank admission metadata around the SAME canonical parser.
//! Caller-owned decoder/source authenticity is explicitly not granted here.
use super::inspection::{InspectionOwner, InspectionPermits};
use super::*;
use crate::analytic::{
    source::SourceCapture, AnalyticBoundarySource, AnalyticProfile, AnalyticStatus,
};
use crate::resource::{Cost, OwnedResourceContext};
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use std::sync::atomic::{AtomicU64, Ordering};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawChainId(u64);
pub struct UntrustedProfileChain {
    id: RawChainId,
    profile: AnalyticProfile,
    profile_source: AnalyticBoundarySource,
    parse_status: AnalyticStatus,
    scale: f64,
    precision: Option<(f64, f64)>,
    pub(super) resources: OwnedResourceContext,
    _permit: resource::Reservation,
    _inspection_permits: InspectionPermits,
}
impl UntrustedProfileChain {
    pub fn id(&self) -> RawChainId {
        self.id
    }
    /// Original simple-admission status is retained, including Unsupported.
    /// Raw loops are evidence, never an accepted replacement profile.
    pub fn original(&self) -> &AnalyticProfile {
        &self.profile
    }
    pub fn parse_status(&self) -> &AnalyticStatus {
        &self.parse_status
    }
    pub fn profile_source(&self) -> &AnalyticBoundarySource {
        &self.profile_source
    }
    pub fn unit_scale(&self) -> f64 {
        self.scale
    }
    pub fn declared_precision(&self) -> Option<(f64, f64)> {
        self.precision
    }
}
/// Consume only an inspection decoder. Production must use the borrowed canonical
/// parser inside its independently authenticated reached ItemSource control.
pub fn capture_untrusted_profile_chain(
    profile: &DecodedEntity,
    decoder: EntityDecoder<'_>,
) -> Result<Arc<UntrustedProfileChain>, RegionError> {
    let mut owner = InspectionOwner::new(decoder);
    resource::check_current()?;
    // The decoder and ALL cache/read permits share rollback ownership.
    owner.permits._context = Some(resource::charge(Cost {
        live_bytes: 1024,
        ..Default::default()
    })?);
    let resources = OwnedResourceContext::capture_current();
    let result = resources.with_scope(|| {
        owner.permits._metadata = Some(admit_decoder_metadata(
            owner.decoder.as_ref().expect("live inspection decoder"),
        )?);
        owner.permits.reads = Vec::with_capacity(2);
        let decoder = owner.decoder.as_mut().expect("live inspection decoder");
        let (bytes, curve) = preflight(profile, decoder, &mut owner.permits.reads)?;
        let permit = resource::charge(Cost {
            live_bytes: bytes,
            copy_bytes: bytes,
            ..Default::default()
        })?;
        let scale = decoder.length_unit_scale();
        if !scale.is_finite() || scale <= 0. {
            return Err(refused(RegionRefusal::Source(
                "invalid length units".into(),
            )));
        }
        let precision = decoder
            .geometric_context_precision_range()
            .map_err(|error| refused(RegionRefusal::Source(error.to_string())))?;
        let mut original = super::super::profile::parse_original_profile(profile, decoder);
        resources.check()?;
        let parse_status = original.status.clone();
        if matches!(parse_status, AnalyticStatus::Complete) {
            if let Err(reason) = super::super::profile::validate_original_profile_accounted(
                profile, decoder, &original,
            ) {
                original.status = AnalyticStatus::Unsupported(reason);
            }
        }
        resources.check()?;
        let mut capture = SourceCapture::enabled();
        capture.record(profile, decoder);
        capture.record(&curve, decoder);
        let profile_source = capture.finish(profile.id, decoder.plane_angle_to_radians());
        resources.check()?;
        if !matches!(profile_source.capture_status, AnalyticStatus::Complete) {
            return Err(refused(RegionRefusal::Source(
                "incomplete original profile record".into(),
            )));
        }
        if original.loops.iter().any(|boundary| {
            boundary
                .source
                .as_ref()
                .is_none_or(|source| !matches!(source.capture_status, AnalyticStatus::Complete))
        }) {
            return Err(refused(RegionRefusal::Source(
                "incomplete original boundary records".into(),
            )));
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| resource::overflow())?;
        // One combined pre-admitted backing owner; no deep Clone implementation.
        // The separate fixed context permit follows the same input lifetime.
        let inspection_permits = owner.finish();
        let result = Arc::new(UntrustedProfileChain {
            id: RawChainId(id),
            profile: original,
            profile_source,
            parse_status,
            scale,
            precision,
            resources: resources.clone(),
            _permit: permit,
            _inspection_permits: inspection_permits,
        });
        Ok(result)
    });
    resources.check()?;
    result
}
fn preflight(
    profile: &DecodedEntity,
    decoder: &mut EntityDecoder<'_>,
    permits: &mut Vec<resource::Reservation>,
) -> Result<(u64, DecodedEntity), RegionError> {
    if profile.ifc_type == IfcType::IfcArbitraryProfileDefWithVoids {
        return Err(refused(RegionRefusal::MultipleLoops));
    }
    if profile.ifc_type != IfcType::IfcArbitraryClosedProfileDef {
        return Err(refused(RegionRefusal::SourceFamily));
    }
    resource::charge(Cost {
        work: 2,
        ..Default::default()
    })?
    .retain();
    let id = profile
        .get_ref(slot::IfcArbitraryClosedProfileDef::OUTER_CURVE.index())
        .ok_or_else(|| refused(RegionRefusal::SourceFamily))?;
    admit_record_read(decoder, id, permits)?;
    let curve = decoder
        .decode_by_id(id)
        .map_err(|e| refused(RegionRefusal::Source(e.to_string())))?;
    if curve.ifc_type != IfcType::IfcIndexedPolyCurve {
        return Err(refused(RegionRefusal::SourceFamily));
    }
    let point_id = curve
        .get_ref(slot::IfcIndexedPolyCurve::POINTS.index())
        .ok_or_else(|| refused(RegionRefusal::SourceFamily))?;
    admit_record_read(decoder, point_id, permits)?;
    let points = decoder
        .decode_by_id(point_id)
        .map_err(|e| refused(RegionRefusal::Source(e.to_string())))?;
    #[cfg(test)]
    super::inspection::probes::notify(
        super::inspection::probes::Phase::ReachedPoints,
        Some(decoder),
    );
    if !matches!(
        points.ifc_type,
        IfcType::IfcCartesianPointList2D | IfcType::IfcCartesianPointList3D
    ) {
        return Err(refused(RegionRefusal::SourceFamily));
    }
    let coordinate_slot = match points.ifc_type {
        IfcType::IfcCartesianPointList2D => slot::IfcCartesianPointList2D::COORD_LIST.index(),
        _ => slot::IfcCartesianPointList3D::COORD_LIST.index(),
    };
    let count = points
        .get_list(coordinate_slot)
        .ok_or_else(|| refused(RegionRefusal::SourceFamily))?
        .len();
    if count > super::super::profile::MAX_LOOPS {
        return Err(resource::refused(
            resource::Dimension::Representation,
            count as u64,
            super::super::profile::MAX_LOOPS as u64,
            resource::RefusalReason::Limit,
        )
        .into());
    }
    if let Some(items) = curve.get_list(slot::IfcIndexedPolyCurve::SEGMENTS.index()) {
        if items.len() > super::super::profile::MAX_LOOPS {
            return Err(resource::overflow().into());
        }
        let mut segments = 0usize;
        for item in items {
            resource::charge(Cost {
                work: 1,
                ..Default::default()
            })?
            .retain();
            let (kind, value) = item
                .as_typed()
                .ok_or_else(|| refused(RegionRefusal::SourceFamily))?;
            let len = value
                .as_list()
                .ok_or_else(|| refused(RegionRefusal::SourceFamily))?
                .len();
            let output = if kind == "IFCARCINDEX" {
                1
            } else {
                len.saturating_sub(1)
            };
            segments = segments
                .checked_add(output)
                .ok_or_else(resource::overflow)?;
            if segments > super::super::profile::MAX_LOOPS {
                return Err(resource::overflow().into());
            }
        }
    }
    // No coefficient traversal: these are the three fixed EXPRESS records which
    // the canonical IndexedPolyCurve extractor/SourceCapture already consumes.
    // Bound its complete Vec/record/value and topology scratch backing BEFORE
    // invoking it. Rounding/allocator overhead remain outside requested backing.
    let mut work = MAX_REGION_WORK;
    let mut bytes = 0u64;
    for entity in [profile, &curve, &points] {
        for value in entity.attributes.iter() {
            bytes = bytes
                .checked_add(measure(value, 0, &mut work)?)
                .ok_or_else(resource::overflow)?;
        }
    }
    // A value can emit at most one segment; the generous per-value envelope
    // covers points, indexed copies, geometric doubling, frames, owned source
    // trees/strings and topology curve headers, plus fixed refinement scratch.
    resource::charge(Cost {
        work: (MAX_REGION_WORK - work)
            .checked_mul(32)
            .ok_or_else(resource::overflow)?,
        ..Default::default()
    })?
    .retain();
    let bytes = bytes
        .checked_mul(32)
        .and_then(|n| n.checked_add(262144))
        .ok_or_else(resource::overflow)?;
    Ok((bytes, curve))
}
fn measure(value: &AttributeValue, depth: u32, work: &mut u64) -> Result<u64, RegionError> {
    resource::charge(Cost {
        work: 1,
        ..Default::default()
    })?
    .retain();
    if *work == 0 || depth as usize >= super::super::source::MAX_SOURCE_VALUE_DEPTH {
        return Err(resource::refused(
            resource::Dimension::Representation,
            1,
            0,
            resource::RefusalReason::Limit,
        )
        .into());
    }
    *work -= 1;
    let mut bytes = std::mem::size_of::<AttributeValue>() as u64 + 128;
    match value {
        AttributeValue::List(values) => {
            if values.len() as u64 > *work {
                return Err(resource::refused(
                    resource::Dimension::Work,
                    values.len() as u64,
                    *work,
                    resource::RefusalReason::Limit,
                )
                .into());
            }
            for child in values {
                bytes = bytes
                    .checked_add(measure(child, depth + 1, work)?)
                    .ok_or_else(resource::overflow)?;
            }
        }
        AttributeValue::Typed { name, value } => {
            bytes = bytes
                .checked_add(name.len() as u64)
                .and_then(|n| n.checked_add(128))
                .ok_or_else(resource::overflow)?;
            bytes = bytes
                .checked_add(measure(value, depth + 1, work)?)
                .ok_or_else(resource::overflow)?;
        }
        AttributeValue::String(v) | AttributeValue::Binary(v) | AttributeValue::Enum(v) => {
            bytes = bytes
                .checked_add(v.len() as u64)
                .ok_or_else(resource::overflow)?
        }
        _ => {}
    }
    Ok(bytes)
}

fn admit_record_read(
    decoder: &mut EntityDecoder<'_>,
    id: u32,
    permits: &mut Vec<resource::Reservation>,
) -> Result<(), RegionError> {
    resource::check_current()?;
    // Fixed-rank source read only. No STEP parsing or geometric walk here;
    // canonical decoder/CurveWalk remain the only interpreters. One source byte
    // cannot encode more than one value; reserve a conservative requested-value
    // envelope before decoder/interpretation backing is materialized.
    let bytes = decoder
        .get_raw_bytes(id)
        .ok_or_else(|| refused(RegionRefusal::Source("missing source record".into())))?
        .len();
    if bytes as u64 > MAX_REGION_WORK {
        return Err(resource::refused(
            resource::Dimension::Work,
            bytes as u64,
            MAX_REGION_WORK,
            resource::RefusalReason::Limit,
        )
        .into());
    }
    let backing = bytes
        .checked_mul(std::mem::size_of::<AttributeValue>() + 128)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(resource::overflow)?;
    let permit = resource::charge(Cost {
        live_bytes: backing as u64,
        work: bytes as u64,
        ..Default::default()
    })?;
    permits.push(permit);
    Ok(())
}

// This inspection API does not borrow the production source owner. Bound shared
// lazy units/Precision decoding before invocation using actual source bytes;
// the bundle is ONLY a resource envelope, never reached-source authentication.
fn admit_decoder_metadata(
    decoder: &EntityDecoder<'_>,
) -> Result<resource::Reservation, RegionError> {
    let inputs = decoder
        .trusted_inputs()
        .filter(|inputs| inputs.source().owns_decoder(decoder))
        .ok_or_else(|| {
            resource::refused(
                resource::Dimension::Coverage,
                0,
                0,
                resource::RefusalReason::UnsupportedCoverage,
            )
        })?;
    let bytes = inputs.source().bytes().len() as u64;
    if bytes > MAX_REGION_WORK {
        return Err(resource::refused(
            resource::Dimension::Work,
            bytes,
            MAX_REGION_WORK,
            resource::RefusalReason::Limit,
        )
        .into());
    }
    // One byte cannot encode more than one value. Cover decoded/cache copies,
    // token/source headers and scans before any lazy lookup. Unit assignments
    // may repeat large records: prepay quadratic byte work, not merely entry
    // count. Original caller-owned source/index storage precedes this API.
    let backing = bytes
        .checked_mul((std::mem::size_of::<AttributeValue>() as u64 + 128) * 8)
        .and_then(|v| v.checked_add(262144))
        .ok_or_else(resource::overflow)?;
    Ok(resource::charge(Cost {
        live_bytes: backing,
        copy_bytes: backing,
        work: bytes
            .checked_mul(bytes)
            .and_then(|n| n.checked_mul(1024))
            .ok_or_else(resource::overflow)?,
        ..Default::default()
    })?)
}
