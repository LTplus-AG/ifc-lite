// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The little-endian byte writer every section is built with: the native twin
//! of `BufferWriter` in `packages/cache/src/utils/buffer-utils.ts`.
//!
//! The format has no alignment padding anywhere (`BufferWriter.writeTypedArray`
//! copies raw bytes at the current position), so neither does this.

#[derive(Default)]
pub(crate) struct Buf {
    bytes: Vec<u8>,
}

impl Buf {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self { bytes: Vec::with_capacity(capacity) }
    }

    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    pub(crate) fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    /// `DataView.setFloat32`: the canonical quiet NaN for any NaN, which is
    /// what Rust's `f32::NAN` already is. Every NaN this crate writes is that
    /// constant, so the bit pattern matches the TS writer's.
    pub(crate) fn f32(&mut self, value: f32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn f64(&mut self, value: f64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub(crate) fn bytes(&mut self, value: &[u8]) {
        self.bytes.extend_from_slice(value);
    }

    /// `BufferWriter.writeString`: a u32 byte length, then the UTF-8 bytes.
    pub(crate) fn string(&mut self, value: &str) {
        self.u32(value.len() as u32);
        self.bytes(value.as_bytes());
    }

    pub(crate) fn u32s(&mut self, values: &[u32]) {
        self.bytes.reserve(values.len() * 4);
        for value in values {
            self.u32(*value);
        }
    }

    pub(crate) fn f32s(&mut self, values: &[f32]) {
        self.bytes.reserve(values.len() * 4);
        for value in values {
            self.f32(*value);
        }
    }

    pub(crate) fn into_vec(self) -> Vec<u8> {
        self.bytes
    }
}

/// ECMAScript `ToUint32`: what `DataView.setUint32` stores for a JS number.
/// The TS writer sums `indexCount / 3` per mesh, so a triangle total can be
/// fractional before it is stored; this truncates it exactly as the TS side.
pub(crate) fn to_uint32(value: f64) -> u32 {
    if !value.is_finite() {
        return 0;
    }
    let truncated = value.trunc();
    truncated.rem_euclid(4_294_967_296.0) as u32
}
