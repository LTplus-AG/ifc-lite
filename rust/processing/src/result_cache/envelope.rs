// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The entry envelope: a fixed little-endian header, a section directory and
//! four contiguous sections.
//!
//! ```text
//! 0    magic "IFCLNRC\x01"            8
//! 8    format version u32             4
//! 12   header length u32 (= 200)      4
//! 16   section count u32 (= 4)        4
//! 20   flags u32 (= 0)                4
//! 24   total length u64               8
//! 32   cache key                     32
//! 64   source SHA-256                32
//! 96   source length u64              8
//! 104  request digest                32
//! 136  engine digest                 32
//! 168  SHA-256(header[0..168] ++ directory)  32
//! 200  directory: 4 x { kind u32, flags u32, offset u64, length u64, count u64, SHA-256 }
//! 456  META | TEXTURES | MESHES | INSTANCES, back to back, ending at total length
//! ```
//!
//! Validation runs in full before any section is decoded: lengths, the
//! identity fields against the caller's expectation, the directory digest, the
//! fixed section order, contiguity (no overlap, no gap, nothing past the end)
//! and every section's SHA-256. A checksum detects damage, not authorship; see
//! the trust notes in `mod.rs`.

use super::mesh_codec::{
    decode_instances, decode_meshes, decode_textures, encode_instances, encode_meshes, encode_textures,
    texture_table,
};
use super::meta_codec::{decode_meta, encode_meta, Meta, MetaRef};
use super::wire::{Reader, Writer};
use super::CodecError;
use crate::ProcessingResult;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::ops::Range;

pub(super) const MAGIC: [u8; 8] = *b"IFCLNRC\x01";
/// Bump on any change to the byte layout or to what a section means.
pub(super) const FORMAT_VERSION: u32 = 1;
pub(super) const HEADER_LEN: usize = 200;
const IDENTITY_END: usize = 168;
const DIR_ENTRY_LEN: usize = 64;
const SECTIONS: [(u32, &str); 4] = [(1, "meta"), (2, "textures"), (3, "meshes"), (4, "instances")];
pub(super) const BODY_START: usize = HEADER_LEN + SECTIONS.len() * DIR_ENTRY_LEN;

/// What an entry must be about, checked field by field on read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EntryIdentity {
    pub(super) key: [u8; 32],
    pub(super) source_sha256: [u8; 32],
    pub(super) source_len: u64,
    pub(super) request_digest: [u8; 32],
    pub(super) engine_digest: [u8; 32],
}

/// A validated entry: each section's byte range and record count.
pub(super) struct Layout {
    sections: [(Range<usize>, usize); 4],
}

/// Structural facts the producer guarantees and the decoder re-checks. The
/// encoder refuses to publish a result that fails them, so a quirk of the
/// pipeline can never turn into a permanent miss-and-rewrite loop.
pub(super) fn check_invariants(result: &ProcessingResult) -> Result<(), CodecError> {
    let bad = CodecError::Invariant;
    if result.mesh_coordinate_space != result.frame.coordinate_space() {
        return Err(bad("coordinate space disagrees with frame"));
    }
    for mesh in &result.meshes {
        let vertices = mesh.positions.len() / 3;
        if mesh.positions.len() % 3 != 0 || mesh.normals.len() % 3 != 0 || mesh.indices.len() % 3 != 0 {
            return Err(bad("mesh array is not whole triples"));
        }
        if mesh.indices.iter().any(|&i| i as usize >= vertices) {
            return Err(bad("index past the vertex count"));
        }
        if mesh.uvs.as_ref().is_some_and(|uv| uv.len() % 2 != 0) {
            return Err(bad("uv array is not whole pairs"));
        }
        if let Some(rgba) = mesh.texture.as_ref().and_then(|t| t.rgba.as_ref().map(|p| (t, p))) {
            let (t, pixels) = rgba;
            let want = (t.width as usize).checked_mul(t.height as usize).and_then(|n| n.checked_mul(4));
            if want != Some(pixels.len()) {
                return Err(bad("texture pixels disagree with its size"));
            }
        }
    }
    let templates: HashSet<u32> = result.meshes.iter().map(|m| m.express_id).collect();
    if result.instances.iter().any(|i| !templates.contains(&i.template_express_id)) {
        return Err(bad("instance names a template that is not a mesh"));
    }
    Ok(())
}

/// A lower bound on the encoded size: the raw array and pixel payload alone.
/// If it is already over a limit the entry certainly is, so a huge result is
/// refused before anything is encoded or allocated for it.
pub(super) fn payload_lower_bound(result: &ProcessingResult) -> u64 {
    let (table, _) = texture_table(&result.meshes);
    let arrays: u64 = result
        .meshes
        .iter()
        .map(|m| {
            let floats = m.positions.len() + m.normals.len() + m.uvs.as_ref().map_or(0, Vec::len);
            ((floats + m.indices.len()) as u64).saturating_mul(4)
        })
        .fold(0u64, u64::saturating_add);
    let pixels = table.iter().map(|p| p.len() as u64).fold(0u64, u64::saturating_add);
    arrays.saturating_add(pixels)
}

/// An encoded entry as its header-plus-directory and its four section bodies,
/// written out in order without first concatenating them.
pub(super) struct EncodedEntry {
    pub(super) head: Vec<u8>,
    pub(super) bodies: [Vec<u8>; 4],
}

impl EncodedEntry {
    pub(super) fn len(&self) -> usize {
        self.head.len() + self.bodies.iter().map(Vec::len).sum::<usize>()
    }
    pub(super) fn parts(&self) -> [&[u8]; 5] {
        [&self.head, &self.bodies[0], &self.bodies[1], &self.bodies[2], &self.bodies[3]]
    }
}

/// The entry as one buffer (tests and tools).
pub(super) fn encode_entry(result: &ProcessingResult, id: &EntryIdentity) -> Result<Vec<u8>, CodecError> {
    Ok(encode_parts(result, id)?.parts().concat())
}

pub(super) fn encode_parts(result: &ProcessingResult, id: &EntryIdentity) -> Result<EncodedEntry, CodecError> {
    check_invariants(result)?;
    let mut meta = Writer::default();
    encode_meta(
        &mut meta,
        &MetaRef {
            mesh_coordinate_space: result.mesh_coordinate_space,
            frame: &result.frame,
            site_transform: &result.site_transform,
            building_transform: &result.building_transform,
            metadata: &result.metadata,
            stats: &result.stats,
        },
    );
    let (table, index) = texture_table(&result.meshes);
    let mut textures = Writer::default();
    encode_textures(&mut textures, &table);
    let mut meshes = Writer::default();
    encode_meshes(&mut meshes, &result.meshes, &index);
    let mut instances = Writer::default();
    encode_instances(&mut instances, &result.instances);
    let bodies = [(meta.0, 1), (textures.0, table.len()), (meshes.0, result.meshes.len()), (instances.0, result.instances.len())];

    let total = bodies.iter().try_fold(BODY_START, |acc, (b, _)| acc.checked_add(b.len())).ok_or(CodecError::Overflow)?;
    let mut out = Vec::with_capacity(BODY_START);
    out.extend_from_slice(&MAGIC);
    for v in [FORMAT_VERSION, HEADER_LEN as u32, SECTIONS.len() as u32, 0] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&(total as u64).to_le_bytes());
    out.extend_from_slice(&id.key);
    out.extend_from_slice(&id.source_sha256);
    out.extend_from_slice(&id.source_len.to_le_bytes());
    out.extend_from_slice(&id.request_digest);
    out.extend_from_slice(&id.engine_digest);
    let mut directory = Vec::with_capacity(SECTIONS.len() * DIR_ENTRY_LEN);
    let mut offset = BODY_START;
    for ((kind, _), (body, count)) in SECTIONS.iter().zip(&bodies) {
        directory.extend_from_slice(&kind.to_le_bytes());
        directory.extend_from_slice(&0u32.to_le_bytes());
        for v in [offset as u64, body.len() as u64, *count as u64] {
            directory.extend_from_slice(&v.to_le_bytes());
        }
        directory.extend_from_slice(&Sha256::digest(body));
        offset += body.len();
    }
    let dir_digest = Sha256::new().chain_update(&out[..IDENTITY_END]).chain_update(&directory).finalize();
    out.extend_from_slice(&dir_digest);
    out.extend_from_slice(&directory);
    let [(meta, _), (textures, _), (meshes, _), (instances, _)] = bodies;
    let entry = EncodedEntry { head: out, bodies: [meta, textures, meshes, instances] };
    debug_assert_eq!(entry.len(), total);
    Ok(entry)
}

fn le_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().expect("4-byte slice"))
}
fn le_u64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().expect("8-byte slice"))
}

/// Check everything about `bytes` except the section contents' own syntax.
/// Nothing in an entry is exposed unless this passes.
pub(super) fn validate_entry(bytes: &[u8], expected: &EntryIdentity) -> Result<Layout, CodecError> {
    if bytes.len() < 12 {
        return Err(CodecError::Truncated);
    }
    if bytes[..8] != MAGIC {
        return Err(CodecError::BadMagic);
    }
    let version = le_u32(bytes, 8);
    if version != FORMAT_VERSION {
        return Err(CodecError::Unsupported(version));
    }
    if bytes.len() < BODY_START {
        return Err(CodecError::Truncated);
    }
    if le_u32(bytes, 12) as usize != HEADER_LEN || le_u32(bytes, 16) as usize != SECTIONS.len() || le_u32(bytes, 20) != 0 {
        return Err(CodecError::Layout("header shape"));
    }
    if le_u64(bytes, 24) != bytes.len() as u64 {
        return Err(CodecError::Layout("total length disagrees with the file"));
    }
    let id = EntryIdentity {
        key: bytes[32..64].try_into().expect("32 bytes"),
        source_sha256: bytes[64..96].try_into().expect("32 bytes"),
        source_len: le_u64(bytes, 96),
        request_digest: bytes[104..136].try_into().expect("32 bytes"),
        engine_digest: bytes[136..168].try_into().expect("32 bytes"),
    };
    if id != *expected {
        return Err(CodecError::IdentityMismatch);
    }
    let directory = &bytes[HEADER_LEN..BODY_START];
    let dir_digest = Sha256::new().chain_update(&bytes[..IDENTITY_END]).chain_update(directory).finalize();
    if dir_digest[..] != bytes[IDENTITY_END..HEADER_LEN] {
        return Err(CodecError::Checksum("directory"));
    }
    let mut next = BODY_START;
    let mut sections: [(Range<usize>, usize); 4] = Default::default();
    for (i, (kind, name)) in SECTIONS.iter().enumerate() {
        let e = &directory[i * DIR_ENTRY_LEN..(i + 1) * DIR_ENTRY_LEN];
        if le_u32(e, 0) != *kind || le_u32(e, 4) != 0 {
            return Err(CodecError::Layout("section order"));
        }
        let to_usize = |v: u64| usize::try_from(v).map_err(|_| CodecError::Overflow);
        let (offset, len, count) = (to_usize(le_u64(e, 8))?, to_usize(le_u64(e, 16))?, to_usize(le_u64(e, 24))?);
        let end = offset.checked_add(len).ok_or(CodecError::Overflow)?;
        if offset != next || end > bytes.len() {
            return Err(CodecError::Layout("sections overlap, leave a gap or run past the end"));
        }
        if Sha256::digest(&bytes[offset..end])[..] != e[32..64] {
            return Err(CodecError::Checksum(name));
        }
        sections[i] = (offset..end, count);
        next = end;
    }
    if next != bytes.len() {
        return Err(CodecError::Layout("bytes after the last section"));
    }
    Ok(Layout { sections })
}

/// Decode a [`validate_entry`]-checked entry, then re-check the invariants.
pub(super) fn decode_entry(bytes: &[u8], layout: &Layout) -> Result<ProcessingResult, CodecError> {
    let [meta, textures, meshes, instances] = &layout.sections;
    if meta.1 != 1 {
        return Err(CodecError::Malformed("meta", "count is not 1"));
    }
    let mut r = Reader::new(&bytes[meta.0.clone()]);
    let Meta { mesh_coordinate_space, frame, site_transform, building_transform, metadata, stats } =
        decode_meta(&mut r)?;
    r.finish("meta")?;
    let mut r = Reader::new(&bytes[textures.0.clone()]);
    let table = decode_textures(&mut r, textures.1)?;
    r.finish("textures")?;
    let mut r = Reader::new(&bytes[meshes.0.clone()]);
    let mesh_list = decode_meshes(&mut r, meshes.1, &table)?;
    r.finish("meshes")?;
    let mut r = Reader::new(&bytes[instances.0.clone()]);
    let instance_list = decode_instances(&mut r, instances.1)?;
    r.finish("instances")?;
    let result = ProcessingResult {
        meshes: mesh_list,
        instances: instance_list,
        mesh_coordinate_space,
        frame,
        site_transform,
        building_transform,
        metadata,
        stats,
    };
    check_invariants(&result)?;
    Ok(result)
}
