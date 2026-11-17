// SPDX-License-Identifier: MPL-2.0
//! `objectId`: a UUID per object for adapters that can set Rhino object ids.
//!
//! The first object of an element is its GlobalId expanded to the 128-bit
//! GUID it compresses (`ifc_lite_core::guid::decode_bits`, MSB first, the
//! inverse of the GlobalId encoder). Every other object (the 2nd..nth
//! part of a grouped element, or an element without a valid GlobalId) gets a
//! name-based RFC 9562 version-8 UUID from the crate's deterministic 128-bit
//! hash of `<GlobalId or #express id>#<part index>`.
//!
//! Ids are unique across the scene: openNURBS silently replaces an object
//! whose id is taken. An id already handed out (two elements sharing a
//! GlobalId) falls back to the hash of `#<express id>#<part index>`.

use std::collections::HashSet;

use ifc_lite_core::guid::{decode_bits, hash128};

/// The object ids handed out so far in one scene.
#[derive(Default)]
pub(super) struct ObjectIds {
    taken: HashSet<u128>,
}

impl ObjectIds {
    /// The id of part `part` of element `express_id`, and whether the
    /// GlobalId-derived one was taken so the express-id fallback was used.
    pub(super) fn claim(&mut self, global_id: Option<&str>, express_id: u32, part: usize) -> (String, bool) {
        let expanded = if part == 0 { global_id.and_then(decode_bits) } else { None };
        let preferred = expanded.unwrap_or_else(|| {
            let seed = global_id.map_or_else(|| format!("#{express_id}"), str::to_string);
            version_8(hash128(&format!("{seed}#{part}")))
        });
        if self.taken.insert(preferred) {
            return (format_uuid(preferred), false);
        }
        // `#<n>` past the fallback only answers an engineered hash collision.
        let fallback = std::iter::once(format!("#{express_id}#{part}"))
            .chain((2u64..).map(|n| format!("#{express_id}#{part}#{n}")))
            .map(|seed| version_8(hash128(&seed)))
            .find(|&bits| self.taken.insert(bits))
            .expect("an unbounded seed range");
        (format_uuid(fallback), true)
    }
}

/// Stamp the RFC 9562 version (8, custom) and variant (`10`) bits.
fn version_8(bits: u128) -> u128 {
    let bits = (bits & !(0xf << 76)) | (0x8 << 76);
    (bits & !(0x3 << 62)) | (0x2 << 62)
}

fn format_uuid(b: u128) -> String {
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        (b >> 96) as u32,
        (b >> 80) as u16,
        (b >> 64) as u16,
        (b >> 48) as u16,
        b & 0xffff_ffff_ffff
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object_id(global_id: Option<&str>, express_id: u32, part: usize) -> String {
        ObjectIds::default().claim(global_id, express_id, part).0
    }

    /// Through the encoder, which `guid_tests` pins against an independent decoder.
    #[test]
    fn first_part_expands_the_global_id() {
        let bits = 0x5079_e1d3_4472_4bbb_6a82_bc78_bba6_ab29_u128;
        let gid = ifc_lite_core::guid::encode(bits);
        assert_eq!(object_id(Some(&gid), 1, 0), "5079e1d3-4472-4bbb-6a82-bc78bba6ab29");
    }

    #[test]
    fn later_parts_are_stable_version_8_uuids() {
        let gid = "0K7w7JH7f3ZPHN9GnR$tSv";
        let a = object_id(Some(gid), 1, 1);
        assert_eq!(a, object_id(Some(gid), 1, 1));
        assert_ne!(a, object_id(Some(gid), 1, 2));
        assert_eq!(&a[14..15], "8");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"), "{a}");
        // No GlobalId: still unique per element and part.
        assert_ne!(object_id(None, 1, 0), object_id(None, 2, 0));
    }

    /// A second element with the same GlobalId gets the express-id hash for
    /// every part, never a duplicate openNURBS would silently replace.
    #[test]
    fn a_taken_id_falls_back_to_the_express_id_hash() {
        let gid = "0K7w7JH7f3ZPHN9GnR$tSv";
        let mut ids = ObjectIds::default();
        let first = [ids.claim(Some(gid), 1, 0), ids.claim(Some(gid), 1, 1)];
        assert!(first.iter().all(|(_, fell_back)| !fell_back));
        let second = [ids.claim(Some(gid), 2, 0), ids.claim(Some(gid), 2, 1)];
        assert_eq!(second[0], (object_id(None, 2, 0), true));
        assert_eq!(second[1], (object_id(None, 2, 1), true));
        // An element without a GlobalId whose hash is taken moves on.
        let (third, fell_back) = ids.claim(None, 2, 0);
        assert!(fell_back && third != second[0].0);
    }
}
