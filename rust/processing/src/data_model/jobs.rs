// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The scanned entity jobs, bucketed by type once, and the per-split decoder.
//!
//! Five extractors each re-filtered the whole job list for their one type
//! (`IFCPROPERTYSET`, `IFCELEMENTQUANTITY` and three `IFCRELASSOCIATES*`):
//! five full passes over millions of records, each comparing every type name
//! (SERVER-38). [`JobBuckets::new`] makes that one pass. Each extractor also
//! built a fresh decoder (an `Arc` clone and an empty cache) per job; a rayon
//! split now owns one ([`SplitDecoder`]).

use super::types::EntityJob;
use ifc_lite_core::{EntityDecoder, EntityIndex};
use std::sync::Arc;

/// The jobs of the types that have their own extractor, in file order. The
/// all-entity passes (metadata, relationships) take the full job list.
#[derive(Default)]
pub(super) struct JobBuckets<'j, 'a> {
    pub(super) property_sets: Vec<&'j EntityJob<'a>>,
    pub(super) quantity_sets: Vec<&'j EntityJob<'a>>,
    pub(super) rel_materials: Vec<&'j EntityJob<'a>>,
    pub(super) rel_classifications: Vec<&'j EntityJob<'a>>,
    pub(super) rel_documents: Vec<&'j EntityJob<'a>>,
}

impl<'j, 'a> JobBuckets<'j, 'a> {
    /// One pass over `jobs`. The type name is matched case-insensitively, as
    /// the per-extractor filters did.
    pub(super) fn new(jobs: &'j [EntityJob<'a>]) -> Self {
        let mut buckets = Self::default();
        for job in jobs {
            let name = job.type_name;
            let bucket = if name.eq_ignore_ascii_case("IFCPROPERTYSET") {
                &mut buckets.property_sets
            } else if name.eq_ignore_ascii_case("IFCELEMENTQUANTITY") {
                &mut buckets.quantity_sets
            } else if name.eq_ignore_ascii_case("IFCRELASSOCIATESMATERIAL") {
                &mut buckets.rel_materials
            } else if name.eq_ignore_ascii_case("IFCRELASSOCIATESCLASSIFICATION") {
                &mut buckets.rel_classifications
            } else if name.eq_ignore_ascii_case("IFCRELASSOCIATESDOCUMENT") {
                &mut buckets.rel_documents
            } else {
                continue;
            };
            bucket.push(job);
        }
        buckets
    }
}

/// Jobs a decoder serves before its entity cache is dropped. A fresh decoder
/// per job kept memory flat; a decoder per split must too, and an all-entity
/// pass would otherwise cache every record it decodes.
const CACHE_JOBS: u32 = 1024;

/// One decoder for the jobs of one rayon split (`map_init`).
///
/// The entity cache is keyed by id, while a job is a byte span. A file may
/// declare an id twice (the index keeps the last, #7682): a shared cache would
/// then hand one span's record to the other span's job, depending on which
/// split the two landed in. So only a job at the span the index resolves its
/// id to reads through the shared cache; any other job gets a fresh decoder,
/// exactly as every job did before.
pub(super) struct SplitDecoder<'a> {
    content: &'a [u8],
    index: Arc<EntityIndex>,
    decoder: EntityDecoder<'a>,
    shadowed: Option<EntityDecoder<'a>>,
    served: u32,
}

impl<'a> SplitDecoder<'a> {
    pub(super) fn new(content: &'a [u8], index: &Arc<EntityIndex>) -> Self {
        Self {
            content,
            index: index.clone(),
            decoder: EntityDecoder::with_arc_index(content, index.clone()),
            shadowed: None,
            served: 0,
        }
    }

    /// The decoder for `job`'s record and the references it follows.
    pub(super) fn next_job(&mut self, job: &EntityJob) -> &mut EntityDecoder<'a> {
        if self.index.get(&job.id).is_some_and(|&(start, _)| start == job.start) {
            return self.next_lookup();
        }
        self.shadowed.insert(EntityDecoder::with_arc_index(self.content, self.index.clone()))
    }

    /// The decoder for a pass that only resolves ids through the index.
    pub(super) fn next_lookup(&mut self) -> &mut EntityDecoder<'a> {
        if self.served == CACHE_JOBS {
            self.decoder.clear_entity_cache();
            self.served = 0;
        }
        self.served += 1;
        &mut self.decoder
    }
}

#[cfg(test)]
#[path = "jobs_tests.rs"]
mod tests;
