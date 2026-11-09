// SPDX-License-Identifier: MPL-2.0
//! Serial browser batch scheduling; one decoder/router and owned snapshot.
use super::style_finishes::BatchFinishes;
use crate::api::IfcAPI;
impl IfcAPI {
    /// Shared core for both batch outputs: run the canonical per-element
    /// producer over `jobs_flat` (setup + loop + CSG/layer diagnostics),
    /// returning each element's meshes (instance metadata intact) + geometry
    /// hash. `process_geometry_batch` (→ MeshCollection, flat) and
    /// `process_geometry_batch_instanced` (→ IFNS shard) both call this so the
    /// hot path is written once. The web path stays serial (no rayon in wasm);
    /// the entity-index Arc, warm router, and per-worker style/void/material
    /// caches are reused exactly as before.
    pub(super) fn produce_batch(
        &self,
        content: &[u8],
        wire: &super::batch_wire::BatchWire<'_>,
        arm_instancing: bool,
    ) -> super::batch_output::BatchOutput {
        let super::batch_wire::BatchWire {
            jobs_flat,
            style_ids,
            rtc_x,
            rtc_y,
            rtc_z,
            needs_shift,
            ..
        } = *wire;
        // Batch wall-clock for the PipelineDiagnostics channel. std::time::Instant
        // traps on wasm32, so the host clock is the JS one there (two Date.now()
        // reads per batch — negligible, always on); see `batch_host`.
        let batch_clock = super::batch_host::BatchClock::start();

        let mut setup = self.prepare_batch(content, wire, arm_instancing);
        // Keep owners outside the mutable setup borrow used by the element loop.
        let style_maps = std::sync::Arc::clone(&setup.style_maps);
        let installed_finishes = self.style_finishes_for(style_ids);
        let mut batch_finishes = BatchFinishes::new(installed_finishes.as_deref(), &style_maps.0);
        let mut state = super::batch_element::BatchState {
            outputs: Vec::with_capacity(jobs_flat.len() / 3),
            ..Default::default()
        };
        self.collect_pipeline_refusals(&setup.decoder);
        for chunk in jobs_flat.chunks_exact(3) {
            self.produce_batch_element(content, chunk, &mut setup, &mut batch_finishes, &mut state);
        }

        let super::batch_element::BatchState {
            mut outputs,
            csg_failures: batch_csg_failures,
            elements: batch_elements,
            backstop: batch_backstop,
            refused: batch_refused,
            occurrences: all_occurrences,
        } = state;
        let super::batch_prepare::BatchSetup {
            mut decoder,
            router,
            mapped_item_cache,
            ctx: _context,
            ..
        } = setup;
        // Surface refused products and the opening / CSG diagnostics. The
        // viewer's large-file path goes processAdaptive -> processParallel ->
        // Web Workers -> `processGeometryBatch`, so the logs must fire here.
        crate::api::warn_refused_products(batch_refused);
        let csg_diag = crate::api::drain_and_log_csg_diagnostics(&router, batch_csg_failures);

        // Layered-wall slicing diagnostics (#563), from this batch's one drain.
        super::batch_host::log_layers(&router.take_layer_slice_diag());

        // #1623 Phase 3: resolve the batch's don't-bake occurrences into shard
        // instances (kept) + recovered flat meshes (sub-threshold / ineligible
        // template). Build the per-rep template facts from the retained instanceable
        // meshes (batch-local mode materialized one template per source), then split.
        // Empty (unarmed / no occurrences) ⇒ nothing changes, byte-identical output.
        let shard_occurrences = super::batch_recovery::recover(
            &mut outputs,
            all_occurrences,
            &mapped_item_cache,
            if needs_shift {
                [rtc_x, rtc_y, rtc_z]
            } else {
                [0.0; 3]
            },
            &mut batch_finishes,
            &mut decoder,
        );

        // Fold this batch into the per-worker PipelineDiagnostics accumulator
        // (read by JS via getPipelineDiagnostics). Counts + two Date.now()
        // reads — cheap enough to stay on the normal load path unconditionally.
        let batch_meshes: u64 = outputs.iter().map(|o| o.meshes.len() as u64).sum();
        let batch_triangles: u64 = outputs
            .iter()
            .flat_map(|o| o.meshes.iter())
            .map(|m| (m.indices.len() / 3) as u64)
            .sum();
        let batch_ms = batch_clock.elapsed_ms();
        // The batch reuses ONE decoder across every element (the point cache is
        // already hoisted here), so its cumulative point-cache stats ARE this
        // batch's faceted-brep memoization tally.
        let (point_cache_hits, point_cache_misses) = decoder.point_cache_stats();
        self.collect_pipeline_refusals(&decoder);
        self.record_pipeline_batch(
            batch_elements,
            batch_meshes,
            batch_triangles,
            batch_backstop,
            point_cache_hits,
            point_cache_misses,
            batch_ms,
            &csg_diag,
        );

        (outputs, csg_diag, shard_occurrences)
    }
}
