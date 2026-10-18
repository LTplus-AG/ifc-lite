// SPDX-License-Identifier: MPL-2.0
//! Standalone compatibility entry; model admission uses the leased decoder.
use super::*;
use ifc_lite_core::build_entity_index;

/// Extract exact swept-disk definitions for product occurrences, optionally
/// restricted to a set of product STEP IDs. An empty set returns no products.
/// Unsupported directrices are reported in each record's `status`; malformed
/// representation walks are reported in `diagnostics` and omitted atomically
/// for the affected product.
pub(in crate::analytic_export) fn extract(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    collect_definitions: bool,
    collect_descriptions: bool,
    collect_extrusions: bool,
) -> ExtractResult {
    let mut mapped_sources = MappedSourceCache::new();
    extract_standalone_with_source_cache(
        content, ids, collect_definitions, collect_descriptions,
        collect_extrusions, &mut mapped_sources,
    )
}

pub(super) fn extract_standalone_with_source_cache(
    content: &[u8],
    ids: Option<&HashSet<u32>>,
    collect_definitions: bool,
    collect_descriptions: bool,
    collect_extrusions: bool,
    mapped_sources: &mut MappedSourceCache,
) -> ExtractResult {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    extract_with_source_cache(&mut decoder, ids, collect_definitions, collect_descriptions,
        collect_extrusions, mapped_sources)
}

