// SPDX-License-Identifier: MPL-2.0
//! Retained candidates from the exact full-pass scheduler; no second classifier.
use super::super::{entity_index::IndexBuilder, scan, ProcessingRequest};
use crate::prepass::Span;
use ifc_lite_core::{IfcType, SourceBundle};
use rustc_hash::{FxHashMap, FxHashSet};

/// Exact full-pass order, including one candidate per orphan type product.
/// Selection filters apply later so source dependencies remain available.
#[doc(hidden)]
pub fn canonical_element_jobs(source: &std::sync::Arc<SourceBundle>) -> Vec<(u32, IfcType)> {
    canonical_jobs_and_type_maps(source).0
}

/// [`canonical_element_jobs`] plus the file's `IfcStyledItem` spans from the SAME scan, so a consumer that
/// joins authored finishes (`ModelFinishes::from_source`) need not read the file again.
#[doc(hidden)]
pub fn canonical_element_jobs_and_styled_items(source: &std::sync::Arc<SourceBundle>) -> (Vec<(u32, IfcType)>, Vec<Span>) {
    let CanonicalScan { jobs, styled_items, .. } = canonical_scan(source);
    (jobs, styled_items)
}

/// Class-1 maps in exact's RepresentationMaps order, without a second classifier.
#[doc(hidden)]
pub fn canonical_type_maps(source: &std::sync::Arc<SourceBundle>) -> FxHashMap<u32, Vec<(u32, u8)>> {
    canonical_jobs_and_type_maps(source).1
}

type CanonicalJobs = (Vec<(u32, IfcType)>, FxHashMap<u32, Vec<(u32, u8)>>);

/// The model driver needs both projections; compute them in a single scan.
pub(crate) fn canonical_jobs_and_type_maps(source: &std::sync::Arc<SourceBundle>) -> CanonicalJobs {
    let CanonicalScan { jobs, maps, .. } = canonical_scan(source);
    (jobs, maps)
}

/// What the one candidate scan yields: the jobs and type maps, and the file's styled-item spans it stashed on the way.
struct CanonicalScan {
    jobs: Vec<(u32, IfcType)>,
    maps: FxHashMap<u32, Vec<(u32, u8)>>,
    styled_items: Vec<Span>,
}

fn canonical_scan(source: &std::sync::Arc<SourceBundle>) -> CanonicalScan {
    let mut decoder = source.decoder();
    let mut unused_index = IndexBuilder::new(source.bytes().len(), false);
    let scanned = scan::scan_entities(
        source.bytes(),
        &ProcessingRequest::full_pass(),
        &mut decoder,
        &mut unused_index,
        false,
    );
    let styled_items = scanned.prepass_spans.styled_items;
    let mut jobs = Vec::new();
    let mut maps: FxHashMap<u32, Vec<(u32, u8)>> = FxHashMap::default();
    let mut seen = FxHashSet::default();
    for job in scanned.entity_jobs {
        let candidate = if let Some(map) = job.representation_map_id {
            maps.entry(job.id).or_default().push((map, 1));
            true
        } else {
            job.ifc_type == IfcType::IfcAlignment
                || ifc_lite_core::nth_attribute_is_present(
                    &source.bytes()[job.start..job.end],
                    ifc_lite_core::slot::IfcProduct::REPRESENTATION.index(),
                )
        };
        if candidate && seen.insert(job.id) { jobs.push((job.id, job.ifc_type)); }
    }
    // Round-2 M9 ruling: exact emits no mesh for curve-only type maps. Keep
    // every map of a candidate (atomic refusal still covers mixed content),
    // but omit types whose complete selection is known to be meshless.
    let router = ifc_lite_geometry::GeometryRouter::new();
    maps.retain(|_, planned| planned.iter().any(|&(map, _)| {
        router.type_map_has_exact_mesh_items(map, &mut decoder).unwrap_or(true)
    }));
    jobs.retain(|(id, ty)| !ty.is_subtype_of(IfcType::IfcTypeProduct) || maps.contains_key(id));
    CanonicalScan { jobs, maps, styled_items }
}
