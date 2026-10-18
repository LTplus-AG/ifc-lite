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
    if !collect_definitions && !collect_extrusions && ids.is_some_and(HashSet::is_empty) {
        return ExtractResult { descriptions: SweptDiskDescriptions::default(), definitions: None, extrusions: None };
    }
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    extract_with_admission(&mut decoder, ids, collect_definitions, collect_descriptions,
        collect_extrusions, mapped_sources, ProductAdmission::ScannedRecord)
}

/// Product source policy is distinct from the shared representation geometry walk.
#[derive(Clone, Copy)]
pub(super) enum ProductAdmission { ScannedRecord, CanonicalDecoder }
impl ProductAdmission {
    pub(super) fn decode(self, decoder: &mut EntityDecoder<'_>, id: u32,
        start: usize, end: usize, seen: &mut HashSet<u32>)
        -> Option<ifc_lite_core::Result<DecodedEntity>>
    {
        match self {
            Self::ScannedRecord => Some(decoder.decode_at_uncached(start, end)),
            Self::CanonicalDecoder if seen.insert(id) => Some(decoder.decode_by_id(id)),
            Self::CanonicalDecoder => None,
        }
    }
}

/// Model admission reuses the actual leased decoder, including its warm caches.
pub(in crate::analytic_export) fn extract_with_source_cache(
    decoder: &mut EntityDecoder<'_>, ids: Option<&HashSet<u32>>,
    definitions: bool, descriptions: bool, extrusions: bool,
    mapped_sources: &mut MappedSourceCache,
) -> ExtractResult {
    extract_with_admission(decoder, ids, definitions, descriptions, extrusions,
        mapped_sources, ProductAdmission::CanonicalDecoder)
}
