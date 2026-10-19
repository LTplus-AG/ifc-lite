// SPDX-License-Identifier: MPL-2.0
//! Explicit rational representation conversion. This is a numerical candidate,
//! never an exact-arithmetic, final-product or target qualification certificate.

/// Counts of unique SDK geometry objects before conversion, in this fixed order:
/// curve BSpline/Line/Circle/Ellipse/Parabola/Hyperbola, surface
/// BSpline/Plane/Cylinder/Cone/Sphere/Torus. No approximate source classes enter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AffineCertificate {
    pub(crate) source_classes: [u32; 12],
}
impl AffineCertificate {
    pub fn source_classes(&self) -> &[u32; 12] { &self.source_classes }
    pub fn representation(&self) -> &'static str { "generic-rational-brep-v1" }
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, &'static str> {
        if bytes.len()!=56 || bytes[..4]!=1u32.to_le_bytes() || bytes[4..8]!=1u32.to_le_bytes() {
            return Err("invalid affine conversion certificate");
        }
        let source_classes=std::array::from_fn(|i| u32::from_le_bytes(
            bytes[8+4*i..12+4*i].try_into().expect("four bytes")));
        if source_classes[..6].iter().map(|v| u64::from(*v)).sum::<u64>()>100000 ||
            source_classes[6..].iter().map(|v| u64::from(*v)).sum::<u64>()>100000 {
            return Err("affine certificate exceeds class budget");
        }
        Ok(Self { source_classes })
    }
}
/// Cheap input admission before dispatch; actual SDK SVD enforces singular
/// value, conditioning and reconstruction policy stated in AFFINE_CONTRACT.md.
pub(crate) fn validate_affine(m: &[f64; 16]) -> Result<(), &'static str> {
    if !m.iter().all(|x| x.is_finite() && x.abs()<=1e9) ||
        m[3]!=0. || m[7]!=0. || m[11]!=0. || m[15]!=1. {
        return Err("expected finite bounded affine matrix");
    }
    let d=m[0]*(m[5]*m[10]-m[9]*m[6])-m[4]*(m[1]*m[10]-m[9]*m[2])+
        m[8]*(m[1]*m[6]-m[5]*m[2]);
    if d==0. { return Err("singular affine matrix"); }
    Ok(())
}
