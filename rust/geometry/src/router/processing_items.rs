// SPDX-License-Identifier: MPL-2.0
//! Canonical item dispatch and cache copies; bounded work uses the same numerics.
use super::{GeometryRouter, GeometryProcessor};
use super::processing::publish_object_frame_bounds;
use super::transforms::instancing_enabled;
use crate::{Error, InstanceMeta, Mesh, Result, math::mat4};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use std::sync::Arc;
const DIRECT_SOLID_TAG: u128 = 1u128 << 127;
impl GeometryRouter {

    /// Mesh one item, rebasing it by `offset_meters` (model RTC expressed in
    /// the item's own coordinate frame) before f32 narrowing.
    ///
    /// The rebase runs only when it reduces the item's coordinate magnitude
    /// (#5684: site-local vertices kilometres from a national-grid site must
    /// stay local) and the processor implements
    /// [`GeometryProcessor::process_in_rtc_frame`]. Every built-in
    /// raw-coordinate processor does; they subtract in f64 so detail below one
    /// f32 ULP at national-grid magnitude survives (#5698). Otherwise the
    /// ordinary output keeps its object frame and final placement applies RTC
    /// in f64: shifting already-f32 output cannot recover precision.
    ///
    /// Returns the unit-scaled mesh. A rebased mesh carries `rtc_applied`
    /// and object-frame `local_bounds`.
    ///
    /// Every walk meshes an item's processor here and nowhere else, so this
    /// is also where the thread-local curve-capped flag (#4901) is drained:
    /// a capped edge is reported for the item that set it, never for the next
    /// item on the thread, whichever walk ran it (ROUTER-26, #7690).
    pub(super) fn process_item_in_rtc_frame(
        &self,
        processor: &dyn GeometryProcessor,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        crate::resource::check_current()?;
        // Drop flags a direct `AdvancedBrepProcessor` call left set on this
        // thread: the drains below must count THIS item only (#7687).
        let _ = crate::processors::take_curve_capped();
        let _ = crate::processors::take_face_refused();
        let rebased = self.raw_item_rtc_file_units(item, decoder, offset_meters)
            .and_then(|rtc_file_units| {
                self.record_processor_dispatch(processor);
                match processor.lower_owned(item, decoder, self.tessellation_quality, Some(rtc_file_units)) {
                    Some(plan) => Some(plan.and_then(|plan| {
                        crate::resource::check_current()?;
                        plan.evaluate()
                    })),
                    None => match crate::resource::check_current() {
                        Err(stop) => Some(Err(stop.into())),
                        Ok(()) => processor.process_in_rtc_frame(item, decoder, self.schema,
                            self.tessellation_quality, rtc_file_units),
                    },
                }
            });
        let rtc_applied = rebased.is_some();
        let result = match rebased {
            Some(result) => result,
            None => match crate::resource::check_current() {
                Err(stop) => Err(stop.into()),
                Ok(()) => {
                self.record_processor_dispatch(processor);
                match processor.lower_owned(item, decoder, self.tessellation_quality, None) {
                    Some(plan) => plan.and_then(|plan| {
                        crate::resource::check_current()?;
                        plan.evaluate()
                    }),
                    None => crate::resource::check_current().map_err(Error::from).and_then(|()|
                        processor.process(item, decoder, self.schema, self.tessellation_quality)),
                }
                }
            },
        };
        if crate::processors::take_curve_capped() {
            self.record_unsupported_item(IfcType::IfcBSplineCurveWithKnots);
        }
        // A face refused because its loop, curve or surface data does not
        // read (#7687, D3): the brep skips it per face, so this is the only
        // place the drop becomes visible.
        for face_type in crate::processors::take_face_refused() {
            self.record_unsupported_item(face_type);
        }
        let mut mesh = crate::resource::observe(result)?;
        // Safety net: strip any out-of-bounds indices before downstream use
        mesh.validate_indices();
        self.scale_mesh(&mut mesh);
        if rtc_applied {
            publish_object_frame_bounds(&mut mesh, offset_meters);
        }
        Ok(mesh)
    }

    /// `offset_meters` in file units when rebasing `item` by it before f32
    /// narrowing reduces the item's coordinate magnitude; `None` when there
    /// is no model RTC or the item is not raw-coordinate geometry (#5684).
    pub(super) fn raw_item_rtc_file_units(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Option<(f64, f64, f64)> {
        (self.has_rtc_offset()
            && self.representation_item_benefits_from_rtc(item, decoder, offset_meters))
        .then(|| {
            (
                offset_meters.0 / self.unit_scale,
                offset_meters.1 / self.unit_scale,
                offset_meters.2 / self.unit_scale,
            )
        })
    }

    pub(super) fn process_representation_item_body(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        crate::resource::check_current()?;
        if crate::resource::is_active() && self.item_dedup_cache.is_some() {
            return Err(crate::resource::refused(crate::resource::Dimension::Coverage, 0, 0,
                crate::resource::RefusalReason::UnsupportedCoverage).into());
        }
        // MappedItem has its own instancing cache (the source representation is
        // already shared), so it never enters the structural-hash path. It also
        // sets its own instance_meta, so the direct-solid tagging below is skipped.
        if item.ifc_type == IfcType::IfcMappedItem {
            return self.process_mapped_item_cached(item, decoder);
        }

        // `None` ⇒ dedup disabled (no hash overhead). On a hit, clone the cached
        // item mesh and stamp its STORED rep_identity (no per-occurrence re-hash);
        // meshing is skipped entirely.
        let dedup_key = self.item_dedup_key_in_frame(item, decoder, offset_meters);
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            let hit = cache
                .meshes
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .cloned();
            if let Some(entry) = hit {
                let (mesh, rep) = (entry.0.clone(), entry.1);
                return Ok(self.stamp_direct_instance(mesh, rep));
            }
        }

        // #4083 (double-count half only — see the module-level cross-reference
        // below): snapshot the item's processor's own failure log BEFORE the
        // uncached build, so any record it adds during THIS call can be
        // attributed to `dedup_key` and, if a racing router sharing this cache
        // already claimed that key, retracted below. `None` when the item's
        // type has no registered processor (nothing to snapshot, nothing to
        // retract) or dedup is disabled (`dedup_key` is `None`).
        let failure_mark = dedup_key.and_then(|_| {
            self.processors
                .get(&item.ifc_type, self.schema)
                .map(|p| p.bool_failure_count())
        });

        let mesh = self.process_representation_item_uncached(item, decoder, offset_meters)?;

        // If this call's processor recorded anything new, decide whether THIS
        // router keeps it: the item-dedup cache's `diagnostic_claimed` set
        // (shared with every router built from the same
        // `enable_content_dedup_shared` cache) lets exactly one racing router
        // keep the diagnostic for one `item_dedup_key`; every other one
        // retracts its own copy of the same logical operation's record.
        //
        // Fixes ONLY the double-count half of #4083: two racing MISSES each
        // computing (and each initially recording) the same tear now collapse
        // to one record. Does NOT fix the omission half — a cache HIT never
        // reaches this code at all (it returns early above, before
        // `process_representation_item_uncached` runs), so it still reports
        // zero diagnostics regardless of what the warm MISS recorded.
        if let (Some(key), Some(before), Some(cache)) =
            (dedup_key, failure_mark, self.item_dedup_cache.as_ref())
        {
            if let Some(processor) = self.processor_for(&item.ifc_type) {
                if processor.bool_failure_count() > before && !cache.claim_diagnostic(key) {
                    processor.truncate_bool_failures_to(before);
                }
            }
        }

        // Compute the instancing rep_identity ONCE for this unique shape so cache
        // hits can reuse it instead of re-hashing the full mesh per occurrence.
        let rep = self.direct_rep_identity(&mesh);

        // Cache the freshly-meshed item under its structural hash. Two exclusions:
        //  - empty meshes (unsupported/degenerate geometry);
        //  - results produced once the per-element CSG budget has tripped. On a
        //    trip the boolean bails and `subtract_mesh` returns the UNCUT host
        //    (records `OperandTooLarge`); since the dedup key is budget-independent
        //    (structure/quality/scale/RTC), caching that fallback would serve the
        //    wrong (uncut) mesh to later identical booleans in a fresh-budget
        //    element (`budget::begin_element()` resets per element). Correctness of
        //    the cut wins over deduping a degraded result. (#1257 review P1.)
        if let (Some(key), Some(cache)) = (dedup_key, self.item_dedup_cache.as_ref()) {
            if !mesh.positions.is_empty() && !crate::kernel::budget::tripped() {
                // Clone into the Arc BEFORE locking: a mesh deep-copy inside the
                // single-Mutex critical section serializes the pool on every miss.
                let cached = Arc::new((mesh.clone(), rep));
                cache
                    .meshes
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key, cached);
            }
        }

        Ok(self.stamp_direct_instance(mesh, rep))
    }

    /// Compute the direct-solid instancing `rep_identity` for a freshly-built,
    /// pre-placement item mesh, or `None` when instancing is off / the mesh is
    /// empty / it already carries metadata (mapped items). FULL 128-bit
    /// (non-sampling) hash: rep_identity has no downstream meshes_equal guard at
    /// the source and must be cross-worker consistent, so a sampled-hash collision
    /// (#833 family) would silently group non-identical geometry; 128-bit makes
    /// that ~2^-127. Computed ONCE per unique shape — cache hits reuse the stored
    /// value via [`Self::stamp_direct_instance`] instead of re-hashing.
    fn direct_rep_identity(&self, mesh: &Mesh) -> Option<u128> {
        if instancing_enabled() && mesh.instance_meta.is_none() && !mesh.positions.is_empty() {
            Some(Self::compute_mesh_hash_full(mesh) | DIRECT_SOLID_TAG)
        } else {
            None
        }
    }

    /// Stamp a direct-solid item mesh with a KNOWN `rep_identity` (no re-hash) so
    /// identical representations collate into a single template + per-occurrence
    /// transforms. `rep` comes from [`Self::direct_rep_identity`] on a fresh build
    /// or from the dedup cache on a hit; `None` is a no-op (instancing off / empty
    /// / already tagged).
    fn stamp_direct_instance(&self, mut mesh: Mesh, rep: Option<u128>) -> Mesh {
        if let Some(exact_rep) = rep {
            mesh.instance_meta = Some(InstanceMeta {
                transform: mat4::IDENTITY,
                local_transform: None,
                canonical_transform: None,
                rep_identity: exact_rep,
                instanceable: true,
            });
        }
        mesh
    }

    /// The meshing body of [`Self::process_representation_item`] (everything except
    /// the MappedItem path and the content-dedup wrapper).
    fn process_representation_item_uncached(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        offset_meters: (f64, f64, f64),
    ) -> Result<Mesh> {
        // Raw-coordinate items rebase in the model frame here; element
        // walkers take `process_raw_item_for_element` first for their own
        // items, so this frame matters for mapped and opening items.
        if let Some(processor) = self.processor_for(&item.ifc_type) {
            let mesh =
                self.process_item_in_rtc_frame(processor.as_ref(), item, decoder, offset_meters)?;

            // Deduplicate by hash - buildings with repeated floors have identical geometry
            if !mesh.positions.is_empty() {
                if crate::resource::is_active() {
                    // The cache moves this producer's backing rather than
                    // deep-copying it: spare capacity remains resident too.
                    let bytes = crate::resource::mesh::resident_bytes(&mesh)
                        .map_err(|_| crate::resource::overflow())?;
                    crate::resource::charge(crate::resource::Cost { live_bytes: bytes, ..Default::default() })?.retain();
                    self.retain_local_resource_account()?;
                    let cached = self.get_or_cache_by_hash(mesh);
                    let (mesh, permit) = crate::resource::mesh::clone_mesh(&cached)?;
                    permit.retain();
                    return Ok(mesh);
                }
                let cached = self.get_or_cache_by_hash(mesh);
                return Ok((*cached).clone());
            }
            return Ok(mesh);
        }

        // No processor is registered for this type. Every `GeometryCategory`
        // that has a real implementation (SweptSolid, ExplicitMesh, Boolean) is
        // already caught by the processor lookup above; `MappedItem` never
        // reaches here (`process_representation_item` intercepts it first, see
        // `process_mapped_item_cached`). So landing here means the type is
        // genuinely unsupported, not merely "not implemented yet".
        Err(Error::geometry(format!(
            "Unsupported representation type: {}",
            item.ifc_type
        )))
    }

    /// A textured `IfcTriangulatedFaceSet` meshed with its per-vertex UVs,
    /// unit-scaled and rebased by `offset_meters` (item frame) when that
    /// preserves precision (#5698). Shared by the occurrence walk and the
    /// type-geometry walk (#7690). `None` when the item is not a face set,
    /// or the textured build fails or is empty.
    pub(crate) fn textured_face_set(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        map: &crate::processors::texture::ResolvedTextureMap,
        offset_meters: Option<(f64, f64, f64)>,
    ) -> Option<(Mesh, Vec<f32>)> {
        crate::resource::check_current().ok()?;
        // A terrain TIN is a face set that only appends `Flags` (#5942).
        if !matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork) {
            return None;
        }
        let rtc = offset_meters.and_then(|offset| {
            self.raw_item_rtc_file_units(item, decoder, offset)
                .zip(Some(offset))
        });
        let plan = crate::program::TextureConstructor::admit(item, decoder,
            rtc.map(|(file_units, _)| file_units)).ok()?;
        crate::resource::check_current().ok()?;
        let (mut mesh, uvs) = plan.evaluate(map);
        crate::resource::check_current().ok()?;
        if mesh.is_empty() {
            return None;
        }
        self.scale_mesh(&mut mesh); // UVs are unaffected by scale
        if let Some((_, offset)) = rtc {
            publish_object_frame_bounds(&mut mesh, offset);
        }
        Some((mesh, uvs))
    }


}

#[cfg(test)]
#[path = "rtc_terminal_tests.rs"]
mod rtc_terminal_tests;
