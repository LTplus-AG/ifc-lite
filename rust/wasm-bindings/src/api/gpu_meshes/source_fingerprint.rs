// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Exact existing JS source content key; does not decode or truncate source bytes.
pub(super) fn source_fingerprint(source: &[u8]) -> String {
    let mut hash = 0x811c9dc5_u32;
    for &byte in source {
        hash = (hash ^ u32::from(byte)).wrapping_mul(0x01000193);
    }
    format!("{:x}-{:x}", source.len(), hash)
}

#[cfg(test)]
mod tests {
    use super::source_fingerprint;

    #[test]
    fn exact_full_source_vectors_include_unparsed_tail() {
        assert_eq!(source_fingerprint(b""), "0-811c9dc5");
        assert_eq!(source_fingerprint(b"hello"), "5-4f9f2cab");
        let valid = b"#1=IFCWALL($);";
        let mut malformed = valid.to_vec();
        malformed.extend_from_slice(b"/* unterminated\0\xff");
        assert_ne!(source_fingerprint(valid), source_fingerprint(&malformed));
        let mut h = 0x811c9dc5_u64;
        for byte in &malformed { h = ((h ^ u64::from(*byte)) * 16777619) & 0xffffffff; }
        assert_eq!(source_fingerprint(&malformed), format!("{:x}-{:x}", malformed.len(), h));
    }
}
