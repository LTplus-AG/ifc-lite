// SPDX-License-Identifier: MPL-2.0
//! The one SHA-256 fingerprint writer: every request/surface/asset digest in
//! this crate feeds its fields through [`Sha256Writer`] and reads the lowercase
//! hex digest back. The field order each caller feeds is part of its cache key
//! and stays at the call site; this type only owns the mechanics (feeding,
//! length framing, `std::io::Write` for `serde_json::to_writer`, hex output).

use sha2::{Digest, Sha256};

#[derive(Default)]
pub(crate) struct Sha256Writer(Sha256);

impl Sha256Writer {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Feed raw bytes.
    pub(crate) fn bytes(&mut self, bytes: impl AsRef<[u8]>) -> &mut Self {
        self.0.update(bytes);
        self
    }

    /// Feed a `u64` little-endian length / count.
    pub(crate) fn len(&mut self, len: usize) -> &mut Self {
        self.bytes((len as u64).to_le_bytes())
    }

    /// Lowercase hex of the digest.
    pub(crate) fn finish_hex(self) -> String {
        format!("{:x}", self.0.finalize())
    }
}

impl std::io::Write for Sha256Writer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Lowercase hex SHA-256 of `bytes`.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn matches_the_published_sha256_vector_however_it_is_fed() {
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_hex(b"abc"), abc);
        let mut w = Sha256Writer::new();
        w.bytes(b"a");
        w.write_all(b"bc").unwrap();
        assert_eq!(w.finish_hex(), abc);
    }

    #[test]
    fn len_is_a_u64_le_frame() {
        let mut a = Sha256Writer::new();
        a.len(3);
        assert_eq!(a.finish_hex(), sha256_hex(&3u64.to_le_bytes()));
    }
}
