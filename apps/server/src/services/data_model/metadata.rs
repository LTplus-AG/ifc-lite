// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Entity metadata extraction.

use super::types::{EntityJob, EntityMetadata};
use ifc_lite_core::EntityDecoder;
use rayon::prelude::*;
use std::sync::Arc;

/// Extract entity metadata for all entities.
pub(super) fn extract_entity_metadata(
    jobs: &[EntityJob],
    content: &Arc<Vec<u8>>,
    entity_index: &Arc<ifc_lite_core::EntityIndex>,
) -> Vec<EntityMetadata> {
    jobs.par_iter()
        .filter_map(|job| {
            let mut local_decoder =
                EntityDecoder::with_arc_index(content.as_slice(), entity_index.clone());
            let entity = local_decoder.decode_at(job.start, job.end).ok()?;

            let global_id = entity.get_string(0).map(|s| s.to_string());
            let name = entity.get_string(2).map(|s| s.to_string());
            let has_geometry = ifc_lite_core::has_geometry_by_name(&job.type_name);

            Some(EntityMetadata {
                entity_id: job.id,
                type_name: job.type_name.clone(),
                global_id,
                name,
                has_geometry,
            })
        })
        .collect()
}
