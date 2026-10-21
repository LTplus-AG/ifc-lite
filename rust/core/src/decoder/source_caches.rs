// SPDX-License-Identifier: MPL-2.0
//! Opaque cache moves carry the provenance of their producing decoder. Raw
//! compatibility imports are trusted inputs, never proof of source identity.
use super::EntityDecoder;
use crate::{DecodedEntity, SourceBundle};
use rustc_hash::FxHashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};

/// A cache produced by a decoder. Entries and authority cannot be supplied
/// independently. Moving a worker cache moves only a map header and Arc.
pub struct SourceCache<T> {
    source: Option<Arc<SourceBundle>>,
    revision: u64,
    entries: FxHashMap<u32, T>,
}
impl<T> Default for SourceCache<T> {
    fn default() -> Self {
        Self {
            source: None,
            revision: 0,
            entries: Default::default(),
        }
    }
}

/// Explicit acceptance of a decoder's current externally authored inputs.
/// This is a trusted configuration revision, NOT source authentication. Later
/// raw imports invalidate it. It cannot be manufactured from an index/token.
#[derive(Clone)]
pub struct TrustedDecoderInputs {
    source: Arc<SourceBundle>,
    revision: u64,
}
impl TrustedDecoderInputs {
    pub fn source(&self) -> &Arc<SourceBundle> {
        &self.source
    }
    pub fn matches(&self, decoder: &EntityDecoder<'_>) -> bool {
        decoder.cache_revision == self.revision
            && decoder
                .source_bundle
                .as_ref()
                .is_some_and(|source| Arc::ptr_eq(source, &self.source))
    }
}

impl EntityDecoder<'_> {
    pub(crate) fn revoke_cache_authority(&mut self) {
        self.execution_owner.publish_cache_source(None);
        self.uniform_precision_cache = Default::default();
        // An unbound decoder has no source authority to protect: any nonzero
        // revision already blocks a later bind, and unbound caches never
        // compare revisions. Skip the process-wide counter on that path, which
        // the per-element cache hoisting in processing hits for every element.
        if self.source_bundle.is_none() {
            self.cache_revision = self.cache_revision.max(1);
            return;
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        self.cache_revision = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .expect("decoder cache revision exhausted");
    }
    pub(crate) fn can_bind_source(&self) -> bool {
        self.cache_revision == 0
            && self.cache.is_empty()
            && self.point_cache.is_empty()
            && self.placement_transform_cache.is_empty()
            && self.project_id_cache.is_none()
            && self.length_unit_scale_cache.is_none()
            && self.plane_angle_to_radians_cache.is_none()
            && self.geometric_precision_cache.is_none()
            && self.uniform_precision_cache.local.is_none()
            && self.schema_version_cache.is_none()
            && self.styled_item_index.get().is_none()
    }
    /// Call only when the caller explicitly trusts all current external inputs.
    /// This does not restore `SourceBundle::owns_decoder` authentication.
    pub fn trusted_inputs(&self) -> Option<TrustedDecoderInputs> {
        self.source_bundle
            .as_ref()
            .map(|source| TrustedDecoderInputs {
                source: Arc::clone(source),
                revision: self.cache_revision,
            })
    }
    fn accepts_cache<T>(&self, cache: &SourceCache<T>) -> bool {
        if cache.entries.is_empty() && cache.source.is_none() && cache.revision == 0 {
            return true;
        }
        match (&self.source_bundle, &cache.source) {
            (Some(a), Some(b)) => self.cache_revision == cache.revision && Arc::ptr_eq(a, b),
            (None, None) => true, // explicit borrowed caller precondition remains
            _ => false,
        }
    }
    pub fn take_source_point_cache(&mut self) -> SourceCache<(f64, f64, f64)> {
        SourceCache {
            source: self.source_bundle.clone(),
            revision: self.cache_revision,
            entries: self.take_point_cache(),
        }
    }
    /// False leaves this decoder unchanged; the foreign cache is not installed.
    pub fn set_source_point_cache(&mut self, cache: SourceCache<(f64, f64, f64)>) -> bool {
        if !self.accepts_cache(&cache) {
            return false;
        }
        self.execution_owner.cache_changed();
        self.execution_owner.changed();
        self.point_cache = cache.entries;
        true
    }
    pub fn take_source_placement_cache(&mut self) -> SourceCache<[f64; 16]> {
        SourceCache {
            source: self.source_bundle.clone(),
            revision: self.cache_revision,
            entries: self.take_placement_transform_cache(),
        }
    }
    /// The memo writer retains its documented canonical-transform precondition;
    /// this checks transfer provenance, not the correctness of extension code.
    pub fn set_source_placement_cache(&mut self, cache: SourceCache<[f64; 16]>) -> bool {
        if !self.accepts_cache(&cache) {
            return false;
        }
        self.execution_owner.cache_changed();
        self.execution_owner.changed();
        self.placement_transform_cache = cache.entries;
        true
    }
    pub fn drain_source_cache(&mut self) -> SourceCache<Arc<DecodedEntity>> {
        SourceCache {
            source: self.source_bundle.clone(),
            revision: self.cache_revision,
            entries: self.drain_cache(),
        }
    }
    /// Share canonically prewarmed records without a source/index scan. The
    /// entry cloning cost is the same as the existing raw injection API.
    pub fn inject_source_cache(&mut self, cache: &SourceCache<Arc<DecodedEntity>>) -> bool {
        if !self.accepts_cache(cache) {
            return false;
        }
        self.execution_owner.cache_changed();
        self.execution_owner.changed();
        self.cache.extend(
            cache
                .entries
                .iter()
                .map(|(&id, entity)| (id, Arc::clone(entity))),
        );
        true
    }
}

#[cfg(test)]
#[path = "source_caches_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "resource_retention_tests.rs"]
mod resource_retention_tests;
