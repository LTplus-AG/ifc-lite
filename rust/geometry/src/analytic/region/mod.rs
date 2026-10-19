// SPDX-License-Identifier: MPL-2.0
//! Inspection-only raw chain and derived region foundation. Neither local ids
//! nor resource ownership authenticate a reached source, runtime result or product.
mod arrange;
mod certify;
mod exact;
mod inspection;
mod raw;
use crate::resource::{self, ProgramStop};
use num_rational::BigRational;
pub use raw::{capture_untrusted_profile_chain, RawChainId, UntrustedProfileChain};
use std::sync::Arc;

#[derive(Debug)]
pub enum RegionError {
    Stopped(ProgramStop),
    Unsupported(RegionRefusal),
}
impl From<ProgramStop> for RegionError {
    fn from(stop: ProgramStop) -> Self {
        Self::Stopped(stop)
    }
}
#[derive(Debug, PartialEq, Eq)]
pub enum RegionRefusal {
    SourceFamily,
    Source(String),
    Curved,
    MultipleLoops,
    FillPolicy,
    Nonfinite,
    Nonplanar,
    Degenerate,
    Gapped,
    Crossing,
    Multiplicity,
    Branching,
    Empty,
    Area,
    Topology(String),
}
fn refused(reason: RegionRefusal) -> RegionError {
    RegionError::Unsupported(reason)
}
// Reuse the existing analytic topology work bound. Limits may tighten it only.
pub const MAX_REGION_WORK: u64 = super::profile_topology::MAX_WORK as u64;
const MAX_RATIONAL_BITS: u64 = 8192;
/// Endpoint-only single-cycle cancellation policy; changing domain needs a new version.
pub const REGION_POLICY_VERSION: u32 = 1;
#[derive(Debug, Clone, Copy)]
pub struct RegionLimits {
    pub work: u64,
}
impl Default for RegionLimits {
    fn default() -> Self {
        Self {
            work: MAX_REGION_WORK,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DerivedRegionId(u64);
/// A partition of one original directed edge. Parameters are exact rationals;
/// endpoints remain original dyadic coordinates, never rounded intersections.
pub struct SourceSpan {
    pub(crate) edge: usize,
    pub(crate) t0: BigRational,
    pub(crate) t1: BigRational,
    pub(crate) start: [f64; 2],
    pub(crate) end: [f64; 2],
}
impl SourceSpan {
    pub fn edge(&self) -> usize {
        self.edge
    }
    pub fn parameters(&self) -> (&BigRational, &BigRational) {
        (&self.t0, &self.t1)
    }
    pub fn endpoints(&self) -> ([f64; 2], [f64; 2]) {
        (self.start, self.end)
    }
}
/// Every atomic span participates exactly once in a reversed cancellation pair
/// or the directed output cycle. Original source survives behind its own permit.
pub struct UntrustedRegionCertificate {
    id: DerivedRegionId,
    source: Arc<UntrustedProfileChain>,
    spans: Vec<SourceSpan>,
    cancellations: Vec<[usize; 2]>,
    cycle: Vec<usize>,
    area2: BigRational,
    _permit: resource::Reservation,
}
impl UntrustedRegionCertificate {
    pub fn policy_version(&self) -> u32 {
        REGION_POLICY_VERSION
    }
    pub fn id(&self) -> DerivedRegionId {
        self.id
    }
    pub fn source(&self) -> &Arc<UntrustedProfileChain> {
        &self.source
    }
    pub fn spans(&self) -> &[SourceSpan] {
        &self.spans
    }
    pub fn cancellations(&self) -> &[[usize; 2]] {
        &self.cancellations
    }
    pub fn cycle(&self) -> &[usize] {
        &self.cycle
    }
    pub fn signed_double_area(&self) -> &BigRational {
        &self.area2
    }
}
/// No Construction, common transaction or runtime seam is entered by this API.
/// Future reached-source binding must independently validate decoder/owner/epoch.
pub fn regularize_untrusted_lines(
    source: Arc<UntrustedProfileChain>,
    limits: RegionLimits,
) -> Result<UntrustedRegionCertificate, RegionError> {
    let resources = source.resources.clone();
    resources.with_scope(|| {
        resources.check()?;
        let result = arrange::run(source, limits);
        resources.check()?;
        result
    })
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod inspection_tests;
