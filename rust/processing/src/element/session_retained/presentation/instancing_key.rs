// SPDX-License-Identifier: MPL-2.0
//! Stable, length-delimited little-endian bytes; no geometric tolerance.
use super::ShapePart;
use sha2::{Digest, Sha256};

pub(super) fn instance_key(representation_map: u32, part: &ShapePart) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"ifc-lite.retained-instance/1");
    hash.update(representation_map.to_le_bytes());
    hash.update((part.positions.len() as u64).to_le_bytes());
    for value in &part.positions { hash.update(value.to_le_bytes()); }
    hash.update((part.indices.len() as u64).to_le_bytes());
    for value in &part.indices { hash.update(value.to_le_bytes()); }
    match &part.normals {
        None => hash.update([0]),
        Some(values) => {
            hash.update([1]);
            hash.update((values.len() as u64).to_le_bytes());
            for value in values { hash.update(value.to_le_bytes()); }
        }
    }
    match &part.faces {
        None => hash.update([0]),
        Some(faces) => {
            hash.update([1]);
            hash.update((faces.table.len() as u64).to_le_bytes());
            for key in &faces.table {
                hash.update(key.item.to_le_bytes());
                hash.update(key.via.to_le_bytes());
                hash.update((key.role.len() as u64).to_le_bytes());
                hash.update(key.role.as_bytes());
            }
            hash.update((faces.triangles.len() as u64).to_le_bytes());
            for index in &faces.triangles { hash.update(index.to_le_bytes()); }
        }
    }
    hash.finalize().into()
}
