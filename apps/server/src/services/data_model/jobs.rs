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
pub(super) struct SplitDecoder<'a> {
    decoder: EntityDecoder<'a>,
    served: u32,
}

impl<'a> SplitDecoder<'a> {
    pub(super) fn new(content: &'a [u8], index: &Arc<EntityIndex>) -> Self {
        Self {
            decoder: EntityDecoder::with_arc_index(content, index.clone()),
            served: 0,
        }
    }

    /// The decoder for the next job.
    pub(super) fn next_job(&mut self) -> &mut EntityDecoder<'a> {
        if self.served == CACHE_JOBS {
            self.decoder.clear_entity_cache();
            self.served = 0;
        }
        self.served += 1;
        &mut self.decoder
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: u32, type_name: &str) -> EntityJob<'_> {
        EntityJob { id, type_name, start: id as usize, end: id as usize + 1 }
    }

    /// The bucket of a type is exactly what the per-extractor filter
    /// `type_name.eq_ignore_ascii_case(..)` selected, in file order, and a
    /// record is in at most one bucket (SERVER-38).
    #[test]
    fn buckets_equal_the_filters_they_replace() {
        let jobs = [
            job(1, "IFCPROPERTYSET"),
            job(2, "IFCWALL"),
            job(3, "IfcPropertySet"),
            job(4, "IFCELEMENTQUANTITY"),
            job(5, "IFCRELASSOCIATESMATERIAL"),
            job(6, "IFCRELASSOCIATESCLASSIFICATION"),
            job(7, "IFCRELASSOCIATESDOCUMENT"),
            job(8, "IFCRELASSOCIATES"),
            job(9, "ifcrelassociatesmaterial"),
        ];
        let ids = |v: &[&EntityJob]| v.iter().map(|j| j.id).collect::<Vec<_>>();
        let b = JobBuckets::new(&jobs);
        assert_eq!(ids(&b.property_sets), [1, 3]);
        assert_eq!(ids(&b.quantity_sets), [4]);
        assert_eq!(ids(&b.rel_materials), [5, 9]);
        assert_eq!(ids(&b.rel_classifications), [6]);
        assert_eq!(ids(&b.rel_documents), [7]);
    }

    /// A split decoder drops its entity cache every `CACHE_JOBS` jobs, so a
    /// pass over millions of records keeps memory flat, and it still decodes
    /// the same record the same way afterwards.
    #[test]
    fn a_split_decoder_decodes_the_same_after_its_cache_rolls_over() {
        let content = b"ISO-10303-21;\nDATA;\n#1=IFCPROJECT('p',$,'Name',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
        let index = Arc::new(ifc_lite_core::build_entity_index(&content[..]));
        let &(start, end) = index.get(&1).expect("indexed");
        let mut split = SplitDecoder::new(&content[..], &index);
        let first = split.next_job().decode_at(start, end).expect("decodes");
        for _ in 0..(CACHE_JOBS * 2 + 1) {
            let again = split.next_job().decode_at(start, end).expect("decodes");
            assert_eq!(again.get_string(2), first.get_string(2));
        }
    }
}
