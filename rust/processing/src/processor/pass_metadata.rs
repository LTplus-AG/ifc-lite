// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Chunk identity/appearance resolution and the one-time deferred style replay.

use super::job::{AppearanceResolver, EntityJob};
use super::jobs::build_color_updates_for_jobs;
use super::pass::PassContext;
use super::ProcessingSink;
use ifc_lite_core::EntityDecoder;
#[cfg(not(target_arch = "wasm32"))]
use rayon::prelude::*;
use rustc_hash::FxHashMap;

/// Fill in a chunk's identity (GlobalId, Name, shape reference), then its
/// appearance. The native pass decodes the identities in parallel with a
/// thread-local decoder and resolves the appearances serially (cache-hit
/// dominated); the wasm32 build runs both steps serially on the shared decoder.
pub(super) fn populate_metadata(
    chunk: &mut [EntityJob],
    ctx: &PassContext<'_>,
    appearance: &mut AppearanceResolver,
    decoder: &mut EntityDecoder<'_>,
) {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let entity_index = ctx.entity_index.clone();
        let content = ctx.content;
        chunk.par_iter_mut().for_each(|job| {
            if !job.needs_identity() {
                return;
            }
            let local_decoder = entity_index.decoder(content);
            // #3987: this decoder is read once; an entity-cache clone is never reused.
            let Ok(entity) = local_decoder.decode_at_uncached(job.start, job.end) else {
                return;
            };
            job.set_identity(&entity);
        });
        for job in chunk.iter_mut() {
            appearance.resolve(job, &ctx.geometry_style_index, decoder);
        }
    }
    #[cfg(target_arch = "wasm32")]
    for job in chunk.iter_mut() {
        // Keep the serial scheduler's existing early-return policy for jobs
        // whose identity was already supplied by the scan (including types).
        if !job.needs_identity() {
            continue;
        }
        let Ok(entity) = decoder.decode_at(job.start, job.end) else {
            continue;
        };
        job.set_identity(&entity);
        appearance.resolve(job, &ctx.geometry_style_index, decoder);
    }
}

/// Replay the saved IFCSTYLEDITEM positions instead of re-scanning the file
/// (~0.5-1 s for 1 GB files), once the first batch is out. The replay is the
/// shared resolver's styled-item building block, so deferred and up-front
/// resolution cannot drift. Colours the first batches went out with are
/// corrected through `on_color_update`.
pub(super) fn replay_deferred_styles(
    ctx: &mut PassContext<'_>,
    sink: &mut dyn ProcessingSink,
    meshed_jobs: &[EntityJob],
    deferred_styled_item_positions: &[(usize, usize)],
    indexed_colour_index: &FxHashMap<u32, [f32; 4]>,
    refusals: &mut Vec<u32>,
) {
    let mut style_decoder = ctx.entity_index.decoder(ctx.content).with_strict_reals();
    let mut rebuilt_styles = crate::prepass::resolve_styled_item_spans(
        deferred_styled_item_positions,
        &mut style_decoder,
    );
    refusals.extend(style_decoder.refused_record_ids());
    crate::prepass::merge_indexed_colours(&mut rebuilt_styles, indexed_colour_index);
    ctx.geometry_style_index = std::sync::Arc::new(rebuilt_styles);
    ctx.run.replace_styles(&ctx.geometry_style_index);
    let deferred_color_updates = build_color_updates_for_jobs(
        meshed_jobs,
        &ctx.geometry_style_index,
        ctx.content,
        &ctx.entity_index,
        refusals,
    );
    if !deferred_color_updates.is_empty() {
        sink.on_color_update(&deferred_color_updates);
    }
}
