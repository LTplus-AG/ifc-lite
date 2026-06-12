// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Consumer-configurable tessellation quality.
//!
//! Geometry tessellation detail (how many segments a curve, arc, cylinder or
//! NURBS patch is approximated with) used to be hardcoded at every call site.
//! [`TessellationQuality`] lets a consumer ask for coarser geometry (faster,
//! fewer triangles) or finer geometry (less faceting on large curved models),
//! and [`scale_segments`] is the single helper every tessellator routes its
//! segment count through.
//!
//! The design pivots on one invariant: **`Medium` is the identity case.** Its
//! [`TessellationQuality::density_factor`] is exactly `1.0`, and
//! [`scale_segments`] short-circuits to the pre-existing `base.clamp(min, max)`
//! at `Medium` so default output is byte-for-byte identical to before the enum
//! existed.

/// Detail level for geometry tessellation, selectable by consumers.
///
/// Levels map to a density multiplier ("angular deflection coefficient") via
/// [`density_factor`](TessellationQuality::density_factor). `Medium` reproduces
/// the engine's historical hardcoded behavior exactly and is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum TessellationQuality {
    /// Coarsest — quarter density. Throughput / preview oriented.
    Lowest,
    /// Half density.
    Low,
    /// Engine default. Byte-for-byte identical to pre-enum behavior.
    #[default]
    Medium,
    /// Double density.
    High,
    /// Finest — quadruple density. Minimizes faceting on curved models.
    Highest,
}

impl TessellationQuality {
    /// Stable lowercase label — the single string surface shared by the wasm
    /// `setTessellationQuality` setter and the server's `tessellation_quality`
    /// query parameter, so the two consumer-facing spellings cannot drift.
    pub fn label(self) -> &'static str {
        match self {
            Self::Lowest => "lowest",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Highest => "highest",
        }
    }

    /// Parse a consumer-facing label (case-insensitive). Inverse of
    /// [`label`](Self::label); `None` for unknown spellings.
    pub fn parse_label(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "lowest" => Some(Self::Lowest),
            "low" => Some(Self::Low),
            "medium" => Some(Self::Medium),
            "high" => Some(Self::High),
            "highest" => Some(Self::Highest),
            _ => None,
        }
    }

    /// Dense 0-4 index (Lowest..Highest). Used by the wasm bindings to store
    /// the level in an atomic; total inverse of [`from_index`](Self::from_index).
    pub fn to_index(self) -> u8 {
        match self {
            Self::Lowest => 0,
            Self::Low => 1,
            Self::Medium => 2,
            Self::High => 3,
            Self::Highest => 4,
        }
    }

    /// Inverse of [`to_index`](Self::to_index); unknown values map to `Medium`.
    pub fn from_index(idx: u8) -> Self {
        match idx {
            0 => Self::Lowest,
            1 => Self::Low,
            3 => Self::High,
            4 => Self::Highest,
            _ => Self::Medium,
        }
    }

    /// Density multiplier applied to segment counts.
    ///
    /// `Medium == 1.0` is load-bearing: it guarantees [`scale_segments`] is the
    /// identity at the default level, so existing golden output never moves.
    #[inline]
    pub fn density_factor(self) -> f64 {
        match self {
            Self::Lowest => 0.25,
            Self::Low => 0.5,
            Self::Medium => 1.0,
            Self::High => 2.0,
            Self::Highest => 4.0,
        }
    }

    /// Segment count for a **profile-plane arc / fillet** (steel-section root
    /// fillets, rounded-rectangle corners, trimmed conics and polycurve arcs in
    /// arbitrary profiles), where `base` is the historical (often chord-adaptive)
    /// count and `min` is the floor.
    ///
    /// Like [`circle_profile_segments`](Self::circle_profile_segments) these never
    /// get *finer* above `Medium` (denser caps only add earcut bridge slivers),
    /// but they coarsen proportionally below `Medium` so large channel/angle
    /// fillets stop dominating the triangle budget on preview levels (issue #976).
    #[inline]
    pub fn profile_arc_segments(self, base: usize, min: usize) -> usize {
        let n = match self {
            Self::Lowest => (base as f64 * 0.25).round() as usize,
            Self::Low => (base as f64 * 0.5).round() as usize,
            Self::Medium | Self::High | Self::Highest => base,
        };
        n.max(min)
    }

    /// Segment count for a **circular profile** outline (opening cutter / cap),
    /// where `base` is the historical fixed count (e.g. 36 for
    /// `IfcCircleProfileDef`).
    ///
    /// Profile circles deliberately do **not** get *finer* above `Medium`:
    /// denser opening circles only multiply the earcut cap-bridge slivers that
    /// show up as scar lines on plates with bolt holes (issue #976). They do get
    /// *coarser* below `Medium` for preview / throughput. The `.min(base)`
    /// guards tiny circles whose `base` is already below the coarse targets.
    #[inline]
    pub fn circle_profile_segments(self, base: usize) -> usize {
        match self {
            Self::Lowest => base.min(8),
            Self::Low => base.min(16),
            Self::Medium | Self::High | Self::Highest => base,
        }
    }
}

/// Scale a tessellator's segment count by the selected quality level.
///
/// `base` is the segment count the call site computed by its own (possibly
/// adaptive) rule; `min`/`max` are that site's existing clamp bounds. At
/// [`TessellationQuality::Medium`] the result is exactly `base.clamp(min, max)`
/// — the historical value. Away from `Medium`, both `base` and the clamp bounds
/// are scaled by [`TessellationQuality::density_factor`], so detail genuinely
/// rises or falls instead of saturating at the old cap. The result is monotonic
/// non-decreasing across the five levels.
#[inline]
pub fn scale_segments(base: usize, min: usize, max: usize, q: TessellationQuality) -> usize {
    if q == TessellationQuality::Medium {
        // Identity path — provably unchanged from pre-enum behavior.
        return base.clamp(min, max);
    }
    let f = q.density_factor();
    let scaled = (base as f64 * f).round() as usize;
    let lo = ((min as f64 * f).round() as usize).max(1);
    let hi = (max as f64 * f).round() as usize;
    scaled.clamp(lo, hi.max(lo))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEVELS: [TessellationQuality; 5] = [
        TessellationQuality::Lowest,
        TessellationQuality::Low,
        TessellationQuality::Medium,
        TessellationQuality::High,
        TessellationQuality::Highest,
    ];

    #[test]
    fn default_is_medium() {
        assert_eq!(TessellationQuality::default(), TessellationQuality::Medium);
    }

    #[test]
    fn medium_factor_is_one() {
        assert_eq!(TessellationQuality::Medium.density_factor(), 1.0);
    }

    #[test]
    fn medium_is_identity_clamp() {
        // For a representative spread of (base, min, max) the Medium result must
        // equal the historical base.clamp(min, max) exactly.
        let cases = [
            (26usize, 8usize, 32usize), // sqrt(10)*8 circle
            (4, 8, 32),                 // below floor
            (200, 8, 32),               // above cap
            (24, 24, 24),               // fixed count
            (36, 36, 36),               // fixed count
            (12, 2, 128),               // trimmed conic
        ];
        for (base, min, max) in cases {
            assert_eq!(
                scale_segments(base, min, max, TessellationQuality::Medium),
                base.clamp(min, max),
                "Medium must be identity for ({base},{min},{max})"
            );
        }
    }

    #[test]
    fn monotonic_non_decreasing_across_levels() {
        // A site with headroom (base below the scaled cap) must scale up
        // monotonically and strictly increase somewhere across the range.
        for (base, min, max) in [(26usize, 8usize, 64usize), (24, 8, 128), (36, 8, 144)] {
            let counts: Vec<usize> = LEVELS
                .iter()
                .map(|&q| scale_segments(base, min, max, q))
                .collect();
            for w in counts.windows(2) {
                assert!(
                    w[0] <= w[1],
                    "not monotonic for base={base}: {counts:?}"
                );
            }
            assert!(
                counts.first() < counts.last(),
                "expected strict increase across range for base={base}: {counts:?}"
            );
        }
    }

    #[test]
    fn circle_profile_segments_coarsen_below_medium_cap_above() {
        use TessellationQuality::*;
        // base 36 → the documented 8/16/36/36/36 mapping.
        assert_eq!(Lowest.circle_profile_segments(36), 8);
        assert_eq!(Low.circle_profile_segments(36), 16);
        for q in [Medium, High, Highest] {
            assert_eq!(q.circle_profile_segments(36), 36, "{q:?} must keep base");
        }
        // Tiny circle whose base is already below the coarse targets: never
        // *increase* it (monotonic, no jump above base).
        assert_eq!(Lowest.circle_profile_segments(6), 6);
        assert_eq!(Low.circle_profile_segments(12), 12);
        assert_eq!(Medium.circle_profile_segments(6), 6);
    }

    #[test]
    fn profile_arc_segments_coarsen_below_medium_cap_above() {
        use TessellationQuality::*;
        // base 24 (a chunky chord-adaptive arc): identity at Medium+, halved at
        // Low, quartered at Lowest.
        assert_eq!(Lowest.profile_arc_segments(24, 2), 6);
        assert_eq!(Low.profile_arc_segments(24, 2), 12);
        for q in [Medium, High, Highest] {
            assert_eq!(q.profile_arc_segments(24, 2), 24, "{q:?} keeps base");
        }
        // Floor respected.
        assert_eq!(Lowest.profile_arc_segments(6, 2), 2);
    }

    #[test]
    fn never_below_one() {
        // Even at Lowest with a tiny base/min the helper never returns zero.
        assert!(scale_segments(2, 2, 8, TessellationQuality::Lowest) >= 1);
    }
}
