// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Verification-only, ordered mesh fingerprint, computed outside timed windows.
//! Includes express/item/material IDs, geometry class, positions, normals,
//! indices, RGBA, origins, local bounds and local-to-world transforms. Lengths
//! and option tags delimit fields; floats use exact IEEE bits, little-endian.
//! Excludes text metadata, material definitions, UVs, textures and instancing.
//! This is a geometry-payload comparison, not full-result byte identity.

use ifc_lite_processing::MeshData;

struct Fnv(u64);

impl Fnv {
    fn bytes(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.0 ^= u64::from(byte);
            self.0 = self.0.wrapping_mul(0x100_0000_01b3);
        }
    }

    fn len(&mut self, len: usize) {
        self.bytes(&(len as u64).to_le_bytes());
    }

    fn floats32(&mut self, values: &[f32]) {
        self.len(values.len());
        for value in values {
            self.bytes(&value.to_bits().to_le_bytes());
        }
    }

    fn floats64(&mut self, values: &[f64]) {
        self.len(values.len());
        for value in values {
            self.bytes(&value.to_bits().to_le_bytes());
        }
    }

    fn optional<T>(&mut self, value: Option<T>, write: impl FnOnce(&mut Self, T)) {
        self.bytes(&[u8::from(value.is_some())]);
        if let Some(value) = value {
            write(self, value);
        }
    }
}

pub(super) fn mesh_fingerprint(meshes: &[MeshData]) -> String {
    let mut hash = Fnv(0xcbf2_9ce4_8422_2325);
    hash.bytes(b"ifc-lite-perf-mesh-v1");
    hash.len(meshes.len());
    for mesh in meshes {
        hash.bytes(&mesh.express_id.to_le_bytes());
        hash.optional(mesh.geometry_item_id, |h, id| h.bytes(&id.to_le_bytes()));
        hash.optional(mesh.material_id, |h, id| h.bytes(&id.to_le_bytes()));
        hash.bytes(&[mesh.geometry_class]);
        hash.floats32(&mesh.positions);
        hash.floats32(&mesh.normals);
        hash.len(mesh.indices.len());
        for index in &mesh.indices {
            hash.bytes(&index.to_le_bytes());
        }
        hash.floats32(&mesh.color);
        hash.floats64(&mesh.origin);
        hash.optional(mesh.local_bounds.as_ref(), |h, v| h.floats32(v));
        hash.optional(mesh.local_to_world.as_ref(), |h, v| h.floats64(v));
    }
    format!("{:016x}", hash.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_matches_known_hello_vector() {
        let mut hash = Fnv(0xcbf2_9ce4_8422_2325);
        hash.bytes(b"hello");
        assert_eq!(hash.0, 0xa430_d846_80aa_bd0b);
    }

    #[test]
    fn fingerprint_preserves_float_bits_and_field_boundaries() {
        let mut mesh = MeshData::new(1, "IfcWall".into(), vec![0.0], vec![1.0], vec![], [1.0; 4]);
        let original = mesh_fingerprint(std::slice::from_ref(&mesh));
        mesh.positions[0] = -0.0;
        assert_ne!(original, mesh_fingerprint(std::slice::from_ref(&mesh)));
        mesh.positions = vec![0.0, 1.0];
        mesh.normals.clear();
        assert_ne!(original, mesh_fingerprint(std::slice::from_ref(&mesh)));
        mesh.positions = vec![0.0];
        mesh.normals = vec![1.0];
        mesh.local_bounds = Some([0.0; 6]);
        assert_ne!(original, mesh_fingerprint(std::slice::from_ref(&mesh)));
    }
}
