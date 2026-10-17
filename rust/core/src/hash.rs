// SPDX-License-Identifier: MPL-2.0
//! Hash homes: FNV-1a for stable, platform-independent fingerprints and one
//! xxh3-128 content key for in-memory dedup grouping.
//!
//! FNV-1a here is the textbook byte-wise algorithm, so values are comparable
//! with every other FNV-1a implementation (and the JS twin for the 32-bit
//! variant). [`Fnv1a64::mix_word`] is a different, word-wise step used by the
//! geometry kernel topology manifests; it is NOT byte-wise FNV and is kept
//! separate so those pinned values never move.

use twox_hash::XxHash3_128;

/// FNV-1a 64-bit offset basis (the state of an empty hash).
pub const FNV64_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV64_PRIME: u64 = 0x0000_0100_0000_01b3;
const FNV32_OFFSET: u32 = 0x811c_9dc5;
const FNV32_PRIME: u32 = 0x0100_0193;

/// Streaming 64-bit FNV-1a.
#[derive(Debug, Clone, Copy)]
pub struct Fnv1a64(u64);

impl Default for Fnv1a64 {
    fn default() -> Self {
        Self::new()
    }
}

impl Fnv1a64 {
    pub const fn new() -> Self {
        Self(FNV64_OFFSET)
    }

    /// Feed bytes one at a time (xor, then multiply by the prime).
    pub fn write(&mut self, bytes: &[u8]) -> &mut Self {
        self.0 = fnv1a64_extend(self.0, bytes);
        self
    }

    /// One word-wise step: xor the whole word, then multiply by the prime.
    /// Not equivalent to [`Fnv1a64::write`] of the word's bytes.
    pub fn mix_word(&mut self, word: u64) -> &mut Self {
        self.0 ^= word;
        self.0 = self.0.wrapping_mul(FNV64_PRIME);
        self
    }

    pub const fn finish(&self) -> u64 {
        self.0
    }
}

/// Continue a 64-bit FNV-1a `state` (start from [`FNV64_OFFSET`]) over `bytes`,
/// for callers that carry the raw `u64` state.
pub fn fnv1a64_extend(state: u64, bytes: &[u8]) -> u64 {
    bytes.iter().fold(state, |h, &b| (h ^ u64::from(b)).wrapping_mul(FNV64_PRIME))
}

/// 64-bit FNV-1a over `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    Fnv1a64::new().write(bytes).finish()
}

/// 32-bit FNV-1a over `bytes` (the JS-twin source fingerprint).
pub fn fnv1a32(bytes: &[u8]) -> u32 {
    bytes.iter().fold(FNV32_OFFSET, |h, &b| (h ^ u32::from(b)).wrapping_mul(FNV32_PRIME))
}

/// xxh3-128 content key. The digest gates key EQUALITY for dedup grouping and
/// must never be persisted or written into an output: the algorithm may change.
pub struct ContentHash(XxHash3_128);

impl Default for ContentHash {
    fn default() -> Self {
        Self::new()
    }
}

impl ContentHash {
    pub fn new() -> Self {
        Self(XxHash3_128::new())
    }

    pub fn write(&mut self, bytes: &[u8]) -> &mut Self {
        self.0.write(bytes);
        self
    }

    pub fn write_u64(&mut self, v: u64) -> &mut Self {
        self.write(&v.to_le_bytes())
    }

    /// A `u64` little-endian length frame, then the raw bit patterns of `data`
    /// (so concatenated runs cannot alias).
    pub fn write_f32s(&mut self, data: &[f32]) -> &mut Self {
        self.write_u64(data.len() as u64);
        self.write(bytemuck::cast_slice::<f32, u8>(data))
    }

    /// As [`ContentHash::write_f32s`] for `u32` runs.
    pub fn write_u32s(&mut self, data: &[u32]) -> &mut Self {
        self.write_u64(data.len() as u64);
        self.write(bytemuck::cast_slice::<u32, u8>(data))
    }

    pub fn finish(&self) -> u128 {
        self.0.finish_128()
    }
}

#[cfg(test)]
#[path = "hash_tests.rs"]
mod tests;
