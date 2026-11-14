// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Little-endian primitives for the result-cache sections.
//!
//! The reader treats its bytes as hostile: every read is bounds-checked, every
//! length is checked against the bytes that remain BEFORE anything is
//! allocated, booleans and option tags accept only 0 and 1, and strings must be
//! UTF-8. Floats travel as raw IEEE bits. Nothing is cast from memory.

use super::CodecError;

#[derive(Default)]
pub(super) struct Writer(pub(super) Vec<u8>);

impl Writer {
    pub(super) fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    pub(super) fn bool(&mut self, v: bool) {
        self.u8(u8::from(v));
    }
    pub(super) fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub(super) fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    pub(super) fn u128(&mut self, v: u128) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    /// A `usize` as `u64`: no host-width integer reaches the file.
    pub(super) fn len(&mut self, v: usize) {
        self.u64(v as u64);
    }
    pub(super) fn f32(&mut self, v: f32) {
        self.u32(v.to_bits());
    }
    pub(super) fn f64(&mut self, v: f64) {
        self.u64(v.to_bits());
    }
    pub(super) fn f32_fixed(&mut self, v: &[f32]) {
        v.iter().for_each(|x| self.f32(*x));
    }
    pub(super) fn f64_fixed(&mut self, v: &[f64]) {
        v.iter().for_each(|x| self.f64(*x));
    }
    pub(super) fn f32_vec(&mut self, v: &[f32]) {
        self.len(v.len());
        self.0.reserve(v.len() * 4);
        self.f32_fixed(v);
    }
    pub(super) fn f64_vec(&mut self, v: &[f64]) {
        self.len(v.len());
        self.f64_fixed(v);
    }
    pub(super) fn u32_vec(&mut self, v: &[u32]) {
        self.len(v.len());
        self.0.reserve(v.len() * 4);
        v.iter().for_each(|x| self.u32(*x));
    }
    pub(super) fn bytes(&mut self, v: &[u8]) {
        self.len(v.len());
        self.0.extend_from_slice(v);
    }
    pub(super) fn str(&mut self, v: &str) {
        self.bytes(v.as_bytes());
    }
    pub(super) fn opt<T>(&mut self, v: Option<T>, f: impl FnOnce(&mut Self, T)) {
        self.bool(v.is_some());
        if let Some(v) = v {
            f(self, v);
        }
    }
    pub(super) fn opt_str(&mut self, v: &Option<String>) {
        self.opt(v.as_deref(), |w, s| w.str(s));
    }
    pub(super) fn opt_u32(&mut self, v: Option<u32>) {
        self.opt(v, |w, x| w.u32(x));
    }
}

pub(super) struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, pos: 0 }
    }

    pub(super) fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }

    /// Every byte consumed: a section with trailing bytes is malformed.
    pub(super) fn finish(&self, section: &'static str) -> Result<(), CodecError> {
        if self.remaining() == 0 {
            Ok(())
        } else {
            Err(CodecError::Malformed(section, "trailing bytes"))
        }
    }

    pub(super) fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        let end = self.pos.checked_add(n).filter(|end| *end <= self.bytes.len());
        let end = end.ok_or(CodecError::Truncated)?;
        let out = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], CodecError> {
        let mut out = [0u8; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    pub(super) fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.array::<1>()?[0])
    }
    pub(super) fn bool(&mut self) -> Result<bool, CodecError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(CodecError::Malformed("wire", "boolean outside 0/1")),
        }
    }
    pub(super) fn u32(&mut self) -> Result<u32, CodecError> {
        Ok(u32::from_le_bytes(self.array()?))
    }
    pub(super) fn u64(&mut self) -> Result<u64, CodecError> {
        Ok(u64::from_le_bytes(self.array()?))
    }
    pub(super) fn u128(&mut self) -> Result<u128, CodecError> {
        Ok(u128::from_le_bytes(self.array()?))
    }
    pub(super) fn f32(&mut self) -> Result<f32, CodecError> {
        Ok(f32::from_bits(self.u32()?))
    }
    pub(super) fn f64(&mut self) -> Result<f64, CodecError> {
        Ok(f64::from_bits(self.u64()?))
    }

    /// A `u64` count of items at least `item_bytes` long each, refused unless
    /// that many could still fit in the remaining bytes. This is the bound on
    /// every allocation the decoder makes.
    pub(super) fn count(&mut self, item_bytes: usize) -> Result<usize, CodecError> {
        let n = usize::try_from(self.u64()?).map_err(|_| CodecError::Overflow)?;
        let need = n.checked_mul(item_bytes.max(1)).ok_or(CodecError::Overflow)?;
        if need > self.remaining() {
            return Err(CodecError::Truncated);
        }
        Ok(n)
    }

    /// A plain `usize` field (not a count): refused when it does not fit.
    pub(super) fn usize(&mut self) -> Result<usize, CodecError> {
        usize::try_from(self.u64()?).map_err(|_| CodecError::Overflow)
    }

    pub(super) fn f32_fixed<const N: usize>(&mut self) -> Result<[f32; N], CodecError> {
        let mut out = [0f32; N];
        for v in &mut out {
            *v = self.f32()?;
        }
        Ok(out)
    }
    pub(super) fn f64_fixed<const N: usize>(&mut self) -> Result<[f64; N], CodecError> {
        let mut out = [0f64; N];
        for v in &mut out {
            *v = self.f64()?;
        }
        Ok(out)
    }
    pub(super) fn f32_vec(&mut self) -> Result<Vec<f32>, CodecError> {
        let n = self.count(4)?;
        let raw = self.take(n * 4)?;
        Ok(raw.chunks_exact(4).map(|c| f32::from_bits(u32::from_le_bytes([c[0], c[1], c[2], c[3]]))).collect())
    }
    pub(super) fn f64_vec(&mut self) -> Result<Vec<f64>, CodecError> {
        let n = self.count(8)?;
        (0..n).map(|_| self.f64()).collect()
    }
    pub(super) fn u32_vec(&mut self) -> Result<Vec<u32>, CodecError> {
        let n = self.count(4)?;
        let raw = self.take(n * 4)?;
        Ok(raw.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
    }
    pub(super) fn bytes(&mut self) -> Result<&'a [u8], CodecError> {
        let n = self.count(1)?;
        self.take(n)
    }
    pub(super) fn str(&mut self) -> Result<String, CodecError> {
        let raw = self.bytes()?;
        std::str::from_utf8(raw).map(str::to_owned).map_err(|_| CodecError::Malformed("wire", "string is not UTF-8"))
    }
    pub(super) fn opt<T>(&mut self, f: impl FnOnce(&mut Self) -> Result<T, CodecError>) -> Result<Option<T>, CodecError> {
        if self.bool()? {
            f(self).map(Some)
        } else {
            Ok(None)
        }
    }
    pub(super) fn opt_str(&mut self) -> Result<Option<String>, CodecError> {
        self.opt(Self::str)
    }
    pub(super) fn opt_u32(&mut self) -> Result<Option<u32>, CodecError> {
        self.opt(Self::u32)
    }
}
