// SPDX-License-Identifier: MPL-2.0
//! Read-only affine conversion evidence shared by retained executors.
//! Decoding a certificate grants no lease, ownership or numerical qualification.

/// Per-family bound on certified unique geometry objects.
const MAX_CLASS_OBJECTS: u64 = 100_000;

/// Counts of unique SDK geometry objects of the source, in this fixed order:
/// curve BSpline/Line/Circle/Ellipse/Parabola/Hyperbola, then surface
/// BSpline/Plane/Cylinder/Cone/Sphere/Torus. Every other class refuses before
/// copying. The counters are not face or edge identities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AffineCertificate {
    source_classes: [u32; 12],
}

impl AffineCertificate {
    pub(crate) fn source_classes(&self) -> &[u32; 12] {
        &self.source_classes
    }
    /// Representation of the copied BRep: every curve and surface generic rational.
    pub(crate) fn representation(&self) -> &'static str {
        "generic-rational-brep-v1"
    }
    /// Decode the versioned adapter certificate; a caller-provided certificate is not a receipt.
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        let word =
            |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
        if bytes.len() != 56 || word(0) != 1 || word(4) != 1 {
            return Err("invalid affine conversion certificate");
        }
        let source_classes: [u32; 12] = std::array::from_fn(|i| word(8 + 4 * i));
        let total = |classes: &[u32]| classes.iter().map(|&n| u64::from(n)).sum::<u64>();
        if total(&source_classes[..6]) > MAX_CLASS_OBJECTS
            || total(&source_classes[6..]) > MAX_CLASS_OBJECTS
        {
            return Err("affine certificate exceeds class budget");
        }
        Ok(Self { source_classes })
    }
}

#[cfg(test)]
#[path = "retained_affine_tests.rs"]
mod tests;
