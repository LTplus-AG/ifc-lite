// SPDX-License-Identifier: MPL-2.0
//! Immutable bytes and their canonically scanned index. No caller-provided
//! identity or independently installed index can manufacture a bundle decoder.
use crate::source_index::{SourceIndex, SourceIndexBuilder};
use crate::{EntityDecoder, EntityScanner};
use std::sync::Arc;

/// One immutable source load. Construction scans original bytes, never a UTF-8
/// rewrite. Cloning the Arc or making a decoder does not rescan or copy inputs.
pub struct SourceBundle {
    bytes: Arc<Vec<u8>>,
    index: SourceIndex,
    grid_axes: Arc<crate::GridAxisIndex>,
    pub(crate) styled_items: std::sync::OnceLock<crate::decoder::StyledItemIndexResult>,
}
impl SourceBundle {
    fn paired(bytes: Arc<Vec<u8>>, index: SourceIndex) -> Arc<Self> {
        Arc::new(Self {
            bytes,
            index,
            grid_axes: Arc::default(),
            styled_items: Default::default(),
        })
    }

    pub fn new(bytes: Vec<u8>) -> Arc<Self> {
        Self::scan_with(Arc::new(bytes), |_, _, _, _| {})
    }

    /// Fuse index construction with an existing canonical classification pass.
    /// The visitor sees canonical scanner records; it cannot supply index rows.
    pub fn scan_with(
        bytes: Arc<Vec<u8>>,
        mut visit: impl FnMut(u32, &str, usize, usize),
    ) -> Arc<Self> {
        let mut index = SourceIndexBuilder::new(bytes.len());
        let mut scanner = EntityScanner::new(bytes.as_slice());
        while let Some((id, name, start, end)) = scanner.next_entity() {
            index.insert(id, (start, end));
            visit(id, name, start, end);
        }
        crate::report_scan_diagnostics(
            scanner.skipped_oversized_ids(),
            scanner.malformed_record_start().is_some(),
        );
        Self::paired(bytes, index.finish())
    }

    /// Build the compact browser representation directly with the existing
    /// canonical index builder, without building or validating a second index.
    pub fn columnar(bytes: Arc<Vec<u8>>) -> Result<Arc<Self>, crate::SpanBeyondU32> {
        let index = crate::ColumnarEntityIndex::from_scan(bytes.as_slice())?;
        Ok(Self::paired(bytes, SourceIndex::Columnar(Arc::new(index))))
    }

    /// Validate a delivered compact index against the canonical byte scanner
    /// once at load. Exact spans and completeness are checked, including the
    /// canonical last-occurrence rule. Equal IDs or lengths alone prove nothing.
    pub fn with_columnar_index(
        bytes: Arc<Vec<u8>>,
        index: Arc<crate::ColumnarEntityIndex>,
    ) -> Result<Arc<Self>, SourceIndexMismatch> {
        let mut scanner = EntityScanner::new(bytes.as_slice());
        let mut matched = 0;
        while let Some((id, _, start, end)) = scanner.next_entity() {
            match index.lookup(id) {
                Some(span) if span == (start, end) => matched += 1,
                Some((later, _)) if later > start => {}
                _ => return Err(SourceIndexMismatch),
            }
        }
        crate::report_scan_diagnostics(
            scanner.skipped_oversized_ids(),
            scanner.malformed_record_start().is_some(),
        );
        if matched != index.len() {
            return Err(SourceIndexMismatch);
        }
        Ok(Self::paired(bytes, SourceIndex::Columnar(index)))
    }

    /// Adopt a pristine decoder over the exact owned allocation. Populated or
    /// externally seeded decoders cannot acquire factory authority. Prewarm a
    /// factory decoder instead, then move its opaque source caches.
    pub fn bind_decoder(self: &Arc<Self>, decoder: &mut EntityDecoder<'_>) -> bool {
        if decoder.entity_index.is_some() || !decoder.can_bind_source() {
            return false;
        }
        if decoder.content.as_ptr() != self.bytes.as_ptr()
            || decoder.content.len() != self.bytes.len()
        {
            return false;
        }
        self.index.install(decoder);
        decoder.set_grid_axis_index(Arc::clone(&self.grid_axes));
        decoder.source_bundle = Some(Arc::clone(self));
        decoder.cache_revision = 0;
        decoder.execution_owner.publish_cache_source(Some(self));
        true
    }

    /// Install this bundle's existing index under the borrowed compatibility
    /// contract: the caller must pair the decoder with these source bytes.
    /// Retains populated decoded caches and refusal state, without granting
    /// factory provenance. Use `decoder()` for fresh authenticated workers.
    pub fn install_compatibility_index(&self, decoder: &mut EntityDecoder<'_>) {
        self.index.install(decoder);
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// A fresh mutable decoder retains the actual paired allocation. It can
    /// move to a scoped worker. The context retains the bundle after its caller
    /// drops the original handle; borrowing that snapshot needs no input copy.
    pub fn decoder(self: &Arc<Self>) -> EntityDecoder<'_> {
        let mut decoder = EntityDecoder::new(self.bytes.as_slice());
        self.index.install(&mut decoder);
        decoder.set_grid_axis_index(Arc::clone(&self.grid_axes));
        decoder.source_bundle = Some(Arc::clone(self));
        decoder.cache_revision = 0;
        decoder.execution_owner.publish_cache_source(Some(self));
        decoder
    }

    /// This compares private factory provenance, not caller-asserted identity,
    /// length, IDs or an arbitrary prebuilt index's allocation address.
    pub fn owns_decoder(self: &Arc<Self>, decoder: &EntityDecoder<'_>) -> bool {
        decoder.cache_revision == 0 && decoder
            .source_bundle
            .as_ref()
            .is_some_and(|source| Arc::ptr_eq(self, source))
    }
}

/// Delivered spans do not describe the original bytes' complete canonical scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceIndexMismatch;
impl std::fmt::Display for SourceIndexMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("entity index does not match source bytes")
    }
}
impl std::error::Error for SourceIndexMismatch {}

#[cfg(test)]
#[path = "source_bundle_tests.rs"]
mod tests;
