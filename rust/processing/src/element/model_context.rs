// SPDX-License-Identifier: MPL-2.0
//! Owned, immutable model inputs captured once per effective batch and shared
//! by every product in it, never copied per product.
//!
//! A [`ProductionModel`] is one model load's lifecycle. Each
//! [`ProductionModel::snapshot`] captures the caller's actual model-level maps
//! into one immutable [`OwnedMeshProductionContext`] under a new revision. Two
//! distinct events are kept apart:
//!
//! - a new snapshot (a later configuration revision of the same source) never
//!   changes or expires an earlier one;
//! - [`ProductionModel::invalidate_source`] is the explicit source replacement
//!   that expires every snapshot taken before it.
//!
//! Dropping the model or the caller's own map owners expires nothing: the
//! snapshot owns what it captured. This is the borrowed compatibility contract:
//! the caller still pairs decoder bytes with their index itself, and a valid
//! lifecycle is not source authentication.
use super::{FullIndexedColourMap, GeometryStyleInfo, MeshProductionContext};
use ifc_lite_geometry::ResolvedTextureMap;
use rustc_hash::FxHashMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// The model-level maps one effective batch selects. Build it by moving maps
/// into `Arc`s or cloning the caller's existing model-level `Arc`s; a snapshot
/// never clones a map.
#[derive(Clone, Default)]
pub struct OwnedMeshProductionData {
    pub void_index: Arc<FxHashMap<u32, Vec<u32>>>,
    pub geometry_style_index: Arc<FxHashMap<u32, GeometryStyleInfo>>,
    pub indexed_colour_full: Arc<FxHashMap<u32, FullIndexedColourMap>>,
    pub element_material_colors: Arc<FxHashMap<u32, Vec<[f32; 4]>>>,
    pub texture_index: Arc<FxHashMap<u32, ResolvedTextureMap>>,
    pub site_local_rotation: Option<Arc<Vec<f64>>>,
}

/// Process-local load, source epoch and snapshot revision. This is completion
/// identity, not a content digest: identical maps of two loads never compare
/// equal, and it is not a token to send to another process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ProductionContextId {
    load: u64,
    source_epoch: u64,
    revision: u64,
}

struct ModelState {
    load: u64,
    source_epoch: AtomicU64,
    revision: AtomicU64,
}

/// One model load's explicit source lifecycle. Clones share the lifecycle.
#[derive(Clone)]
pub struct ProductionModel {
    state: Arc<ModelState>,
    #[cfg(any(test, feature = "retained-runtime"))]
    source: Option<Arc<ifc_lite_core::SourceBundle>>,
}

impl Default for ProductionModel {
    fn default() -> Self {
        Self::new()
    }
}

impl ProductionModel {
    /// A new load. The caller retains its borrowed bytes and independently
    /// supplied indexes; no source authentication is promised.
    pub fn new() -> Self {
        // 64-bit counters: wrapping would need 2^64 loads in one process.
        static NEXT_LOAD: AtomicU64 = AtomicU64::new(1);
        Self {
            #[cfg(any(test, feature = "retained-runtime"))]
            source: None,
            state: Arc::new(ModelState {
                load: NEXT_LOAD.fetch_add(1, Ordering::Relaxed),
                source_epoch: AtomicU64::new(0),
                revision: AtomicU64::new(0),
            }),
        }
    }

    /// Capture the actual selected maps under a new revision. A later snapshot
    /// of the same source never changes or expires this one.
    pub fn snapshot(&self, data: OwnedMeshProductionData) -> Arc<OwnedMeshProductionContext> {
        let id = ProductionContextId {
            load: self.state.load,
            source_epoch: self.state.source_epoch.load(Ordering::Acquire),
            revision: self.state.revision.fetch_add(1, Ordering::Relaxed) + 1,
        };
        Arc::new(OwnedMeshProductionContext {
            id,
            data,
            state: Arc::clone(&self.state),
            #[cfg(any(test, feature = "retained-runtime"))]
            source: self.source.clone(),
        })
    }

    /// Whether this load created `context`, whatever its revision. A reuse
    /// check for snapshot caches; it grants no decoder authority.
    pub fn owns_snapshot(&self, context: &OwnedMeshProductionContext) -> bool {
        Arc::ptr_eq(&self.state, &context.state)
    }

    /// Expire every snapshot of the preceding source. Call at explicit source
    /// replacement or mutation; never infer an epoch from map addresses.
    pub fn invalidate_source(&self) {
        self.state.source_epoch.fetch_add(1, Ordering::AcqRel);
    }
}

/// Immutable model inputs a product owns from planning to publication. `Send`
/// and `Sync`: one snapshot serves every rayon worker of its batch.
pub struct OwnedMeshProductionContext {
    id: ProductionContextId,
    data: OwnedMeshProductionData,
    state: Arc<ModelState>,
    #[cfg(any(test, feature = "retained-runtime"))]
    source: Option<Arc<ifc_lite_core::SourceBundle>>,
}

impl OwnedMeshProductionContext {
    pub fn id(&self) -> ProductionContextId {
        self.id
    }

    /// `Err(StaleSource)` once the model explicitly invalidated the source this
    /// snapshot was taken from. One atomic load and compare.
    #[inline]
    pub fn validate_source(&self) -> Result<(), ProductionContextError> {
        if self.id.source_epoch == self.state.source_epoch.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(stale_source())
        }
    }

    /// The borrowed per-product view over the owned maps. Nothing is copied.
    pub fn borrowed(&self) -> MeshProductionContext<'_> {
        MeshProductionContext {
            void_index: &self.data.void_index,
            geometry_style_index: &self.data.geometry_style_index,
            indexed_colour_full: &self.data.indexed_colour_full,
            element_material_colors: &self.data.element_material_colors,
            texture_index: &self.data.texture_index,
            site_local_rotation: self.data.site_local_rotation.as_deref(),
        }
    }
}

#[cold]
#[inline(never)]
fn stale_source() -> ProductionContextError {
    ProductionContextError::StaleSource
}

/// Why an owned production refused to start or to publish.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProductionContextError {
    /// The model explicitly invalidated the snapshot's source.
    StaleSource,
    /// The decoder or router could not be admitted or kept for this product:
    /// other live work holds it, or a callback replaced it mid-product.
    OwnerUnavailable,
}

impl fmt::Display for ProductionContextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::StaleSource => "production model source was invalidated",
            Self::OwnerUnavailable => "production decoder or router could not be admitted or was replaced during the product",
        })
    }
}

impl std::error::Error for ProductionContextError {}

// Refs #7955: private source-bound consumer.
#[cfg(any(test, feature = "retained-runtime"))]
#[cfg_attr(not(test), allow(dead_code))]
#[path = "model_context_retained.rs"]
pub(super) mod retained;
