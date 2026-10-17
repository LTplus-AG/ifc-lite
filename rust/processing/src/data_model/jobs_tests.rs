// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `jobs.rs`: the job buckets and the per-split decoder.

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
    let first = split.next_lookup().decode_at(start, end).expect("decodes");
    for _ in 0..(CACHE_JOBS * 2 + 1) {
        let again = split.next_lookup().decode_at(start, end).expect("decodes");
        assert_eq!(again.get_string(2), first.get_string(2));
    }
}

/// A record whose id the file declares twice decodes as its own span, not
/// as the other declaration a previous job of the split cached.
#[test]
fn a_duplicate_id_job_reads_its_own_span() {
    let content = b"ISO-10303-21;\nDATA;\n#1=IFCWALL('a',$,'First',$,$,$,$,$,$);\n#1=IFCWALL('b',$,'Last',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let index = Arc::new(ifc_lite_core::build_entity_index(&content[..]));
    let mut scanner = ifc_lite_core::EntityScanner::new(&content[..]);
    let mut jobs = Vec::new();
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        jobs.push(EntityJob { id, type_name, start, end });
    }
    assert_eq!(jobs.len(), 2);
    let mut split = SplitDecoder::new(&content[..], &index);
    for (job, name) in jobs.iter().rev().zip(["Last", "First"]) {
        let decoder = split.next_job(job);
        let entity = decoder.decode_at(job.start, job.end).expect("decodes");
        assert_eq!(entity.get_string(2), Some(name));
        // Within the job, its own id resolves to its own record, as with
        // the fresh per-job decoder this replaced.
        assert_eq!(decoder.decode_by_id(1).expect("resolves").get_string(2), Some(name));
    }
}
