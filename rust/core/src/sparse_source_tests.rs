// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::{build_entity_index, EntityDecoder};

const FILE: &str = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCPROJECT('g',$,'p #99 is not a reference',$,$,$,$,(#2),$);\n\
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);\n\
#3=IFCAXIS2PLACEMENT3D(#4,$,$);\n\
#4=IFCCARTESIANPOINT((0.,0.,0.));\n\
#10=IFCWALL('w',$,$,$,$,#11,#12,$,$);\n\
#11=IFCLOCALPLACEMENT($,#3);\n\
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));\n\
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));\n\
#14=IFCTRIANGULATEDFACESET(#15,$,$,((1,2,3)),$);\n\
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));\n\
#20=IFCINDEXEDCOLOURMAP(#14,$,#21,(1));\n\
#21=IFCCOLOURRGBLIST(((1.,0.,0.)));\n\
#30=IFCWALL('dangling',$,$,$,$,#777,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

fn fetch(source: &mut SparseSource, file: &[u8], ids: &[u32]) -> Vec<u32> {
    let index = build_entity_index(file);
    let mut absent = Vec::new();
    let spans: Vec<(u32, usize, usize)> = ids
        .iter()
        .filter_map(|&id| match index.get(&id) {
            Some(&(start, end)) => Some((id, start, end - start)),
            None => {
                absent.push(id);
                None
            }
        })
        .collect();
    source.install(&spans, file);
    source.mark_absent(&absent);
    absent
}

/// Install the closure of `roots` round by round, as the worker does.
fn close(source: &mut SparseSource, file: &[u8], roots: &[u32]) -> usize {
    let mut rounds = 0;
    let mut walk = roots.to_vec();
    loop {
        let mut missing = Vec::new();
        source.expand(&walk, u32::MAX, &mut missing);
        if missing.is_empty() {
            return rounds;
        }
        fetch(source, file, &missing);
        walk = missing;
        rounds += 1;
    }
}

#[test]
fn references_skip_strings_and_the_instance_name() {
    let mut refs = Vec::new();
    for_each_record_ref(b"#1=IFCX('a #5 b','it''s #6',#7,(#8,#9),$,#4294967296);", |id| refs.push(id));
    assert_eq!(refs, vec![7, 8, 9], "quoted ids, the record's own id and a >u32 id are not references");
}

#[test]
fn references_after_a_comment_are_still_found() {
    let mut refs = Vec::new();
    for_each_record_ref(b"#5=IFCWALL('g',#2,/* it's #3 */ #7,1./2.,#8);", |id| refs.push(id));
    assert_eq!(refs, vec![2, 7, 8], "a quote or an id inside a comment is neither a string nor a reference");

    refs.clear();
    for_each_record_ref(b"#1 /* a=#9 */ = IFCX(#2,#3);", |id| refs.push(id));
    assert_eq!(refs, vec![2, 3], "an `=` inside a comment before the assignment does not end the instance name");
}

#[test]
fn preamble_is_a_scannable_step_file_with_the_roots_closure() {
    let file = FILE.as_bytes();
    let index = build_entity_index(file);
    let preamble = build_sparse_preamble(file, |id| index.get(&id).copied(), &[1], &[10]);
    let text = std::str::from_utf8(&preamble).unwrap();
    assert!(text.starts_with("ISO-10303-21;"), "the header travels, so FILE_SCHEMA resolves");
    let ids: Vec<u32> = {
        let mut ids: Vec<u32> = build_entity_index(&preamble).into_keys().collect();
        ids.sort_unstable();
        ids
    };
    assert_eq!(ids, vec![1, 2, 3, 4, 10], "project closure plus the wall record alone");
}

#[test]
fn closure_walk_installs_exactly_the_reachable_records() {
    let file = FILE.as_bytes();
    let index = build_entity_index(file);
    let preamble = build_sparse_preamble(file, |id| index.get(&id).copied(), &[1], &[]);
    let mut source = SparseSource::new(preamble);
    let rounds = close(&mut source, file, &[10]);
    assert!(rounds >= 3, "wall, shape, representation, face set, points: {rounds} rounds");
    for id in [10, 11, 12, 13, 14, 15] {
        assert!(source.contains(id), "#{id} is reachable from the wall");
    }
    assert!(!source.contains(20), "an inverse referrer is not reachable without a declared edge");

    // The arena decodes like the file does.
    let arena = source.bytes();
    let mut sparse = EntityDecoder::with_sparse_index(arena.as_slice(), source.index());
    let mut full = EntityDecoder::new(file);
    for id in [10, 13, 14, 15] {
        assert_eq!(
            format!("{:?}", sparse.decode_by_id(id).unwrap()),
            format!("{:?}", full.decode_by_id(id).unwrap()),
        );
    }
    assert!(source.take_misses().is_empty());
}

#[test]
fn declared_inverse_edges_travel_with_their_target() {
    let file = FILE.as_bytes();
    let index = build_entity_index(file);
    let preamble = build_sparse_preamble(file, |id| index.get(&id).copied(), &[1], &[]);
    let mut source = SparseSource::new(preamble);
    source.set_inverse_edges(&[14], &[20]);
    close(&mut source, file, &[10]);
    assert!(source.contains(20) && source.contains(21), "the colour map and its palette follow #14");
}

#[test]
fn a_lookup_outside_the_arena_is_reported_and_a_dangling_one_is_not() {
    let file = FILE.as_bytes();
    let index = build_entity_index(file);
    let preamble = build_sparse_preamble(file, |id| index.get(&id).copied(), &[1], &[]);
    let mut source = SparseSource::new(preamble);
    close(&mut source, file, &[30]);
    let arena = source.bytes();
    let mut decoder = EntityDecoder::with_sparse_index(arena.as_slice(), source.index());
    assert!(decoder.decode_by_id(20).is_err());
    assert!(decoder.decode_by_id(777).is_err());
    drop(decoder);
    assert_eq!(source.take_misses(), vec![20], "#777 is not in the file; #20 is a real gap");
}

#[test]
fn reset_keeps_the_preamble_and_forgets_the_rest() {
    let file = FILE.as_bytes();
    let index = build_entity_index(file);
    let preamble = build_sparse_preamble(file, |id| index.get(&id).copied(), &[1], &[]);
    let base = preamble.len();
    let mut source = SparseSource::new(preamble);
    close(&mut source, file, &[10]);
    assert!(source.stats().arena_bytes > base);
    source.reset();
    assert_eq!(source.stats().arena_bytes, base);
    assert!(source.contains(1) && !source.contains(10));
    // The walk state was dropped too: the same roots are fetched again.
    close(&mut source, file, &[10]);
    assert!(source.contains(15));
    assert_eq!(source.stats().resets, 1);
}

#[test]
fn a_depth_limited_walk_stops_early_and_does_not_block_a_full_one() {
    let file = FILE.as_bytes();
    let index = build_entity_index(file);
    let preamble = build_sparse_preamble(file, |id| index.get(&id).copied(), &[1], &[]);
    let mut source = SparseSource::new(preamble);
    fetch(&mut source, file, &[10]);
    let mut missing = Vec::new();
    source.expand(&[10], 1, &mut missing);
    assert_eq!(missing, vec![11, 12], "one hop from the wall");
    fetch(&mut source, file, &missing);
    // The limited walk kept no state: a full walk from the same root still
    // reaches what lies behind the records it stopped at.
    close(&mut source, file, &[10]);
    assert!(source.contains(15), "the full closure still completes");
}
