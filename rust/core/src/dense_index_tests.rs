// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn dense_index_preserves_holes_zero_ids_and_empty_spans() {
    let ids: Vec<u32> = (0..256).filter(|id| *id != 127).collect();
    let starts: Vec<u32> = ids.iter().map(|id| id * 10).collect();
    let lengths: Vec<u32> = ids.iter().map(|id| if *id == 0 { 0 } else { 5 }).collect();
    let dense = DenseEntityIndex::try_from_columns(&ids, &starts, &lengths).unwrap();
    let columns = crate::ColumnarEntityIndex::from_columns(&ids, &starts, &lengths);
    for id in 0..300 { assert_eq!(dense.lookup(id), columns.lookup(id), "id={id}"); }
    assert_eq!(dense.lookup(0), Some((0, 0)));
    assert_eq!(dense.lookup(u32::MAX), None);
    assert!(dense.starts.len() * 8 + dense.present.len() * 8 <= ids.len() * 12);
}

#[test]
fn dense_index_refuses_sparse_unsorted_duplicate_or_mismatched_columns() {
    for ids in [&[u32::MAX][..], &[1, 1], &[2, 1], &[]] {
        assert!(DenseEntityIndex::try_from_columns(ids, &vec![0; ids.len()], &vec![1; ids.len()]).is_none());
    }
    assert!(DenseEntityIndex::try_from_columns(&[0, 1], &[0], &[1, 1]).is_none());
}

#[test]
fn dense_decoder_resolves_real_step_references() {
    let source = b"DATA;#0=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(42.),$);#1=IFCPROPERTYSET('g',$,'ePSet_MapConversion',$,(#0));";
    let mut scanner = crate::EntityScanner::new(source);
    let (mut ids, mut starts, mut lengths) = (Vec::new(), Vec::new(), Vec::new());
    while let Some((id, _, start, end)) = scanner.next_entity() {
        ids.push(id); starts.push(start as u32); lengths.push((end - start) as u32);
    }
    let mut decoder = EntityDecoder::new(source);
    decoder.set_dense_index(Arc::new(DenseEntityIndex::try_from_columns(&ids, &starts, &lengths).unwrap()));
    let geo = crate::GeoRefExtractor::extract(&mut decoder, &[(1, crate::IfcType::IfcPropertySet)])
        .unwrap().unwrap();
    assert_eq!(geo.eastings, 42.0);
}
