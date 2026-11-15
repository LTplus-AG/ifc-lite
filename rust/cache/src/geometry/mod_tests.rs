// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use record::tests::sample;

fn limited(max_bytes: u64) -> Limits {
    Limits { max_bytes, ..Limits::FORMAT }
}

/// The section as the in-memory writer lays it out: head, then body.
fn section(meshes: &[CacheMesh], compress: bool, limits: Limits) -> Result<(GeometryHead, Vec<u8>), CacheError> {
    let mut body = Vec::new();
    let mut writer = SectionWriter::new(compress, 0, limits);
    for mesh in meshes {
        writer.push(mesh, &mut body)?;
    }
    let head = writer.finish(CoordinateInfo::default(), &mut body)?;
    let mut bytes = head.bytes.clone();
    bytes.extend_from_slice(&body);
    Ok((head, bytes))
}

#[test]
fn the_first_chunk_starts_right_after_the_head() {
    let (_, bytes) = section(&[sample(1, [0.0; 3]), sample(2, [99.0, 0.0, 0.0])], true, Limits::FORMAT).unwrap();
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
    let head_length = word(0);
    let directory = 4 + head_length - 2 * DIRECTORY_ENTRY_BYTES;
    assert_eq!(word(directory - 4), 2, "chunkCount");
    let first = directory + 24;
    assert_eq!(word(first), 4 + head_length, "chunk 0 anchors at the head end");
    let second = first + DIRECTORY_ENTRY_BYTES;
    assert_eq!(word(second), word(first) + word(first + 4), "contiguous");
    assert_eq!(word(second) + word(second + 4), bytes.len());
}

#[test]
fn a_mesh_whose_normals_do_not_pair_is_dropped_from_counts_and_chunks() {
    let mut broken = sample(2, [0.0; 3]);
    broken.normals.pop();
    let (head, _) = section(&[sample(1, [0.0; 3]), broken], false, Limits::FORMAT).unwrap();
    assert_eq!((head.mesh_count, head.skipped_meshes, head.chunk_count), (1, 1, 1));
    assert_eq!((head.total_vertices, head.total_triangles), (3, 1));
}

#[test]
fn a_dropped_mesh_still_widens_the_model_bounds() {
    // The TS `CoordinateHandler` sees meshes before `validateMeshes`.
    let mut broken = sample(2, [500.0, 0.0, 0.0]);
    broken.normals.pop();
    let mut info = CoordinateInfo::default();
    let mut body = Vec::new();
    let mut writer = SectionWriter::new(false, 0, Limits::FORMAT);
    writer.push(&sample(1, [0.0; 3]), &mut body).unwrap();
    writer.push(&broken, &mut body).unwrap();
    let head = writer.finish(info.clone(), &mut body).unwrap();
    info.original_bounds = [[0.0; 3], [501.0, 1.0, 0.0]];
    info.shifted_bounds = info.original_bounds;
    let mut expected = Buf::new();
    coordinate_info::write(&mut expected, &info);
    let written = &head.bytes[4 + 12..4 + 12 + expected.len()];
    assert_eq!(written, expected.into_vec().as_slice());
}

/// #9584: offsets and lengths are u32. A cache past the limit is refused
/// with a typed error, never wrapped, and the streaming writer must refuse
/// before it writes the chunk that crosses it. A 4 GiB file is not needed to
/// show that: the limit is injected.
#[test]
fn issue_9584_a_chunk_that_crosses_the_limit_is_refused_before_it_is_written() {
    let meshes: Vec<CacheMesh> = (0..4).map(|i| sample(i, [100.0 * f64::from(i), 0.0, 0.0])).collect();
    let (head, bytes) = section(&meshes, false, Limits::FORMAT).unwrap();
    let chunk = (head.body_length / 4) as usize;
    assert_eq!(head.body_length as usize, 4 * chunk, "four equal chunks");

    // Room for the length field and two chunks, not three.
    let mut body = Vec::new();
    let mut writer = SectionWriter::new(false, 0, limited(4 + 2 * chunk as u64 + 1));
    let mut refused = None;
    for mesh in &meshes {
        if let Err(error) = writer.push(mesh, &mut body) {
            refused = Some(error);
            break;
        }
    }
    // Four cells, so every chunk stays open until `finish` closes them.
    assert!(refused.is_none(), "nothing closes before the end");
    match writer.finish(CoordinateInfo::default(), &mut body) {
        Err(CacheError::TooLarge(at_least)) => assert_eq!(at_least, 4 + 3 * chunk as u64),
        other => panic!("expected TooLarge, got {:?}", other.err()),
    }
    assert_eq!(body.len(), 2 * chunk, "the crossing chunk was never appended");
    assert!(bytes.len() > 4 + 2 * chunk + 1, "unlimited, the same input fits");
}

#[test]
fn issue_9584_a_head_that_crosses_the_limit_is_refused_at_finish() {
    let meshes = [sample(1, [0.0; 3])];
    let (_, bytes) = section(&meshes, false, Limits::FORMAT).unwrap();
    let exact = bytes.len() as u64;
    assert!(section(&meshes, false, limited(exact)).is_ok(), "a cache exactly at the limit is fine");
    match section(&meshes, false, limited(exact - 1)) {
        Err(CacheError::TooLarge(at_least)) => assert_eq!(at_least, exact),
        other => panic!("expected TooLarge, got {:?}", other.map(|(_, b)| b.len())),
    }
}

#[test]
fn the_limit_counts_from_the_section_start() {
    let meshes = [sample(1, [0.0; 3])];
    let (_, bytes) = section(&meshes, false, Limits::FORMAT).unwrap();
    let mut body = Vec::new();
    let mut writer = SectionWriter::new(false, 1000, limited(1000 + bytes.len() as u64 - 1));
    writer.push(&meshes[0], &mut body).unwrap();
    assert!(matches!(writer.finish(CoordinateInfo::default(), &mut body), Err(CacheError::TooLarge(_))));
}
