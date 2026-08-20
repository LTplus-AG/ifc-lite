// SPDX-License-Identifier: MPL-2.0
//! Unit reconciliation for merged export. Ports the length-scale resolution and
//! compatibility test of `merged-exporter.ts` (`resolveUnitScale`,
//! `unitsCompatible`).
//!
//! Each model's length unit is resolved to an SI scale (metres-per-unit). Two
//! models are *compatible* when their length scales match within a relative
//! tolerance; only compatible models are unified into one project / unit space.
//! Genuine cross-unit rescaling (`unitReconciliation: 'normalize'`) is not done
//! natively in this iteration — the caller gates it to the JS path — so the
//! native merge only ever emits a byte-faithful (unscaled) copy of each model,
//! and an incompatible-unit model is federated (kept as its own project) rather
//! than silently mis-scaled.

use ifc_lite_core::EntityDecoder;

/// Relative tolerance for comparing two length unit scale factors (JS `1e-6`).
const UNIT_SCALE_TOLERANCE: f64 = 1e-6;

/// Resolve a model's length unit SI scale (metres per length unit, e.g. `0.001`
/// for a millimetre file). Falls back to `1.0` when no length unit is declared.
pub fn resolve_length_scale(content: &[u8]) -> f64 {
    let mut decoder = EntityDecoder::new(content);
    let scale = decoder.length_unit_scale();
    if scale > 0.0 && scale.is_finite() {
        scale
    } else {
        1.0
    }
}

/// True when two length scales are equal within [`UNIT_SCALE_TOLERANCE`] (JS
/// `unitsCompatible`): identical, both zero, or within a relative epsilon.
pub fn units_compatible(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    let max = a.abs().max(b.abs());
    if max == 0.0 {
        return true;
    }
    (a - b).abs() <= max * UNIT_SCALE_TOLERANCE
}

#[cfg(test)]
mod units_tests {
    use super::*;

    const MM_FILE: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('g',$,$,$,$,$,$,$,#2);\n#2=IFCUNITASSIGNMENT((#3));\n#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\nENDSEC;\nEND-ISO-10303-21;\n";
    const M_FILE: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('g',$,$,$,$,$,$,$,#2);\n#2=IFCUNITASSIGNMENT((#3));\n#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\nENDSEC;\nEND-ISO-10303-21;\n";

    #[test]
    fn resolves_millimetre_length_scale() {
        assert!((resolve_length_scale(MM_FILE.as_bytes()) - 0.001).abs() < 1e-12);
    }

    #[test]
    fn resolves_metre_length_scale() {
        assert!((resolve_length_scale(M_FILE.as_bytes()) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn compatibility_within_tolerance() {
        assert!(units_compatible(0.001, 0.001));
        assert!(units_compatible(1.0, 1.0 + 1e-9));
        assert!(!units_compatible(0.001, 1.0));
        assert!(units_compatible(1.0, 1.0));
    }
}
