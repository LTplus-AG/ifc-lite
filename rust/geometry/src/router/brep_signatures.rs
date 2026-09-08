// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Completed faceted-BREP signatures shared across one model's routers.

use super::*;

/// Model-scoped memo of completed fast BREP signatures, keyed by express id.
/// Create a fresh cache for every source/model; identical ids in different
/// models must never share this cache. Quality, scale and RTC are folded later.
#[derive(Clone, Default)]
pub struct SharedBrepSignatureCache(Arc<Mutex<FxHashMap<u32, u128>>>);

impl GeometryRouter {
    /// Create a fresh signature cache for ONE immutable loaded model.
    pub fn new_brep_signature_cache() -> SharedBrepSignatureCache {
        SharedBrepSignatureCache::default()
    }

    /// Reuse completed BREP signatures across routers of the SAME source model.
    /// Attach a fresh cache when replacing the source, just like the item cache.
    pub fn enable_shared_brep_signature_cache(&mut self, cache: SharedBrepSignatureCache) {
        self.shared_brep_signatures = Some(cache);
    }

    fn brep_key_with_params(&self, structural: u128) -> u128 {
        super::content_hash::key_with_params(structural, self.tessellation_quality.to_index(), self.unit_scale, self.rtc_offset)
    }

    /// Cache key for an item: its structural hash combined with the router params
    /// that change the meshed output (tessellation quality / unit scale / RTC), or
    /// `None` when dedup is disabled (skips the hash walk so disabled = zero
    /// overhead). The quality fold is what keeps `setTessellationQuality` correct —
    /// the shared cache persists across quality changes on a worker, so the key
    /// must distinguish them (#976).
    pub(super) fn item_dedup_key(&self, item: &DecodedEntity, decoder: &mut EntityDecoder) -> Option<u128> {
        self.item_dedup_cache.as_ref()?;
        // Keep the proven default types; mapped items have their own cache.
        let base = matches!(
            item.ifc_type,
            IfcType::IfcFacetedBrep
                | IfcType::IfcBooleanResult
                | IfcType::IfcBooleanClippingResult
                | IfcType::IfcExtrudedAreaSolid
        );
        // Additive, flagged OFF by default: faceset / surface-model families. Their
        // generic byte signature (`sig_walk_bytes`) is already complete; gated so a
        // low-reuse model never pays the hash for no payback (the #1177 trap).
        let extra = Self::build_dedup_extra_enabled()
            && matches!(
                item.ifc_type,
                IfcType::IfcPolygonalFaceSet
                    | IfcType::IfcTriangulatedFaceSet
                    | IfcType::IfcShellBasedSurfaceModel
                    | IfcType::IfcFaceBasedSurfaceModel
            );
        if !(base || extra) {
            return None;
        }
        // #1909: retain the large-BREP bypass. A completed shared hit already
        // passed this threshold and can skip even the face-count traversal.
        if item.ifc_type == IfcType::IfcFacetedBrep {
            if let Some(cache) = &self.shared_brep_signatures {
                let hit = cache.0.lock().unwrap_or_else(|e| e.into_inner()).get(&item.id).copied();
                if let Some(signature) = hit {
                    return Some(self.brep_key_with_params(signature));
                }
            }
            if let Some(face_count) = super::content_hash::faceted_brep_face_count(decoder, item.id) {
                if face_count > super::content_hash::FACETED_BREP_DEDUP_FACE_LIMIT {
                    return None;
                }
            }
        }
        // Only a completed fast BREP walk is context-independent. Never publish
        // generic recursive hashes, depth cutoffs, cycle sentinels or refusals.
        if item.ifc_type == IfcType::IfcFacetedBrep {
            if let Some(cache) = &self.shared_brep_signatures {
                if super::content_hash::is_faceted_brep(decoder, item.id) {
                    if let Some(signature) = super::content_hash::try_faceted_brep_signature(decoder, item.id) {
                        self.content_sig_memo.borrow_mut().insert(item.id, signature);
                        cache.0.lock().unwrap_or_else(|e| e.into_inner()).insert(item.id, signature);
                        return Some(self.brep_key_with_params(signature));
                    }
                }
                let mut memo = self.content_sig_memo.borrow_mut();
                let mut refused = self.content_hash_oversized_ref_drops.borrow_mut();
                let signature = super::content_hash::item_signature_after_failed_brep(decoder, item.id, &mut memo, &mut refused);
                return Some(self.brep_key_with_params(signature));
            }
        }
        let structural = {
            let mut memo = self.content_sig_memo.borrow_mut();
            let mut refused = self.content_hash_oversized_ref_drops.borrow_mut();
            super::content_hash::item_signature(decoder, item.id, &mut memo, &mut refused)
        };
        Some(super::content_hash::key_with_params(
            structural,
            self.tessellation_quality.to_index(),
            self.unit_scale,
            self.rtc_offset,
        ))
    }

}

#[cfg(test)]
#[path = "brep_signatures_tests.rs"]
mod tests;
