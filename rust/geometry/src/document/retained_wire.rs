// SPDX-License-Identifier: MPL-2.0
//! Pure retained adapter frame and wire validation; no runtime dependency.
//! Frame policy stays shared with the product controller.

pub fn rigid(matrix: [f64; 16]) -> Result<(), &'static str> {
    super::retained_frames::rigid(matrix)
}
pub fn multiply(a: [f64; 16], b: [f64; 16]) -> [f64; 16] {
    super::retained_frames::multiply(a, b)
}
pub fn relative(a: [f64; 16], b: [f64; 16]) -> Result<[f64; 16], &'static str> {
    super::retained_frames::relative(a, b)
}
pub fn validate_affine(matrix: &[f64; 16]) -> Result<(), &'static str> {
    super::retained_frames::validate_affine(matrix)
}

/// Decoded evidence only; neither a lease nor a numerical qualification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AffineCertificate(super::retained_affine::AffineCertificate);
impl AffineCertificate {
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        super::retained_affine::AffineCertificate::decode(bytes).map(Self)
    }
    pub fn source_classes(&self) -> &[u32; 12] {
        self.0.source_classes()
    }
    pub fn representation(&self) -> &'static str {
        self.0.representation()
    }
}

/// The six little-endian words of opcode 10. Empty buffers still require
/// opcode 19's independent solid certificate before sealing an empty result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeshInfo {
    pub vertices: u32,
    pub triangles: u32,
    pub faces: u32,
    pub boundary: u32,
    pub spine: u32,
    pub failures: u32,
}
impl MeshInfo {
    pub fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len() != 24 {
            return Err("invalid retained mesh info length");
        }
        let word = |i| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
        Ok(Self {
            vertices: word(0),
            triangles: word(4),
            faces: word(8),
            boundary: word(12),
            spine: word(16),
            failures: word(20),
        })
    }
    pub fn is_zero(&self) -> bool {
        *self
            == Self {
                vertices: 0,
                triangles: 0,
                faces: 0,
                boundary: 0,
                spine: 0,
                failures: 0,
            }
    }
    pub fn buffer_bytes(&self, max_bytes: u64) -> Result<u64, &'static str> {
        if self.vertices == 0
            || self.triangles == 0
            || self.faces == 0
            || self.boundary != 0
            || self.spine != 0
            || self.failures != 0
        {
            return Err("partial tessellation returned as success");
        }
        // u32 counts widened before arithmetic: cannot overflow u64.
        let bytes = u64::from(self.vertices) * 24 + u64::from(self.triangles) * 88;
        if bytes > max_bytes {
            return Err("mesh exceeds max_bytes");
        }
        Ok(bytes)
    }
}
