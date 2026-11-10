// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The process-wide geometry policy that can change output, read through the
//! SAME accessors the pipeline calls, plus this crate's resolved features.
//!
//! A result cache keys on [`effective_output_policy`] rather than on the
//! environment: every `IFC_LITE_*` knob here is read once into a `OnceLock`
//! (or per call) by its accessor, and several have programmatic overrides
//! (`local_frame_set_enabled_override`, `rect_fast::param_set_enabled_override`,
//! `GeometryRouter::set_build_dedup_extra_override`, `kernel::budget::set_cap`
//! / `set_element_cap`, `set_alt_triangulator`). Reading the environment again
//! would disagree with a `OnceLock` initialised before the variable changed,
//! and would miss the overrides entirely.
//!
//! A new process-global output knob belongs here; the processing crate's
//! `result_cache_policy_ratchet` test fails on an unclassified `IFC_LITE_*`
//! variable.

/// Every feature of this crate and whether this build enabled it. Cargo
/// resolves features per build, so a downstream binary can enable, say,
/// `csg_topology_gate` without the processing crate's own features changing.
/// Kept in step with `Cargo.toml` by a test below.
pub const BUILD_FEATURES: &[(&str, bool)] = &[
    ("retained-runtime", cfg!(feature = "retained-runtime")),
    ("opening-perf-trace", cfg!(feature = "opening-perf-trace")),
    ("debug_geometry", cfg!(feature = "debug_geometry")),
    ("csg_capture", cfg!(feature = "csg_capture")),
    ("wasm_source_capture", cfg!(feature = "wasm_source_capture")),
    ("observability", cfg!(feature = "observability")),
    ("triangulation-alt", cfg!(feature = "triangulation-alt")),
    ("test-support", cfg!(feature = "test-support")),
    ("csg_topology_gate", cfg!(feature = "csg_topology_gate")),
    ("csg_manifold_gate", cfg!(feature = "csg_manifold_gate")),
];

/// The effective value of every process-global geometry output knob.
#[non_exhaustive]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OutputPolicy {
    /// `rect_fast::enabled` (`IFC_LITE_RECT_FAST`).
    pub rect_fast: bool,
    /// `rect_fast::param_enabled` (override, `IFC_LITE_RECT_PARAM`).
    pub rect_param: bool,
    /// Process-wide local-frame fallback (override, `IFC_LITE_LOCAL_FRAME`),
    /// used by every router built without an explicit frame policy.
    pub local_frame: bool,
    /// Coaxial void union (`IFC_LITE_VOID_UNION`).
    pub void_union: bool,
    /// 2D boolean void path (`IFC_LITE_VOID_2D`).
    pub void_2d: bool,
    /// Prism cut path (`IFC_LITE_PRISM_CUT`).
    pub prism_cut: bool,
    /// Extra build-time item dedup (override, `IFC_LITE_DEDUP_EXTRA`).
    pub dedup_extra: bool,
    /// Half-space section cap disabled (`IFC_LITE_HALFSPACE_CAP_OFF`).
    pub halfspace_cap_off: bool,
    /// Preview small-cut skip ratio (`IFC_LITE_FAST_CUT_RATIO`).
    pub fast_cut_ratio: f64,
    /// Per-boolean escalation cap as snapshotted (`u64::MAX` = unbounded).
    pub csg_op_cap: u64,
    /// Per-element escalation cap as snapshotted (`u64::MAX` = unbounded).
    pub csg_element_cap: u64,
    /// Alternate triangulator oracle armed (feature `triangulation-alt`).
    pub alt_triangulator: bool,
}

/// Read the policy now, through the pipeline's own accessors.
pub fn effective_output_policy() -> OutputPolicy {
    OutputPolicy {
        rect_fast: crate::rect_fast::enabled(),
        rect_param: crate::rect_fast::param_enabled(),
        local_frame: crate::router::transforms::local_frame_enabled(),
        void_union: crate::router::voids::coaxial_union::enabled(),
        void_2d: crate::router::voids::bool2d_path::enabled(),
        prism_cut: crate::router::voids::prism_cut::enabled(),
        dedup_extra: crate::GeometryRouter::build_dedup_extra_enabled(),
        halfspace_cap_off: crate::processors::boolean::halfspace_cap::disabled(),
        fast_cut_ratio: crate::processors::boolean::cut_heuristics::fast_cut_skip_ratio(),
        csg_op_cap: crate::kernel::budget::effective_op_cap(),
        csg_element_cap: crate::kernel::budget::effective_element_cap(),
        #[cfg(feature = "triangulation-alt")]
        alt_triangulator: crate::triangulation::alt_oracle::armed(),
        #[cfg(not(feature = "triangulation-alt"))]
        alt_triangulator: false,
    }
}

impl OutputPolicy {
    /// A canonical, versioned byte encoding: fixed field order, explicit
    /// widths, floats as raw bits, followed by [`BUILD_FEATURES`].
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let Self {
            rect_fast,
            rect_param,
            local_frame,
            void_union,
            void_2d,
            prism_cut,
            dedup_extra,
            halfspace_cap_off,
            fast_cut_ratio,
            csg_op_cap,
            csg_element_cap,
            alt_triangulator,
        } = *self;
        let mut out = b"ifc-lite-geometry-output-policy-v1".to_vec();
        let flags =
            [rect_fast, rect_param, local_frame, void_union, void_2d, prism_cut, dedup_extra, halfspace_cap_off, alt_triangulator];
        out.extend(flags.iter().map(|f| u8::from(*f)));
        out.extend_from_slice(&fast_cut_ratio.to_bits().to_le_bytes());
        out.extend_from_slice(&csg_op_cap.to_le_bytes());
        out.extend_from_slice(&csg_element_cap.to_le_bytes());
        out.extend_from_slice(&(BUILD_FEATURES.len() as u64).to_le_bytes());
        for (name, on) in BUILD_FEATURES {
            out.extend_from_slice(&(name.len() as u64).to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.push(u8::from(*on));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A feature added to `Cargo.toml` without a row above would let a build
    /// that enables it share cache entries with one that does not.
    #[test]
    fn build_features_list_every_cargo_feature() {
        let manifest = include_str!("../Cargo.toml");
        let section = manifest.split("\n[features]\n").nth(1).expect("[features] section");
        let section = section.split("\n[").next().unwrap_or(section);
        let mut declared: Vec<&str> = section
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .filter_map(|l| l.split('=').next().map(str::trim))
            .filter(|name| *name != "default")
            .collect();
        declared.sort_unstable();
        let mut listed: Vec<&str> = BUILD_FEATURES.iter().map(|(n, _)| *n).collect();
        listed.sort_unstable();
        assert_eq!(listed, declared);
    }

    #[test]
    fn canonical_bytes_see_every_field() {
        let base = effective_output_policy();
        let variants: [fn(&mut OutputPolicy); 12] = [
            |p| p.rect_fast = !p.rect_fast,
            |p| p.rect_param = !p.rect_param,
            |p| p.local_frame = !p.local_frame,
            |p| p.void_union = !p.void_union,
            |p| p.void_2d = !p.void_2d,
            |p| p.prism_cut = !p.prism_cut,
            |p| p.dedup_extra = !p.dedup_extra,
            |p| p.halfspace_cap_off = !p.halfspace_cap_off,
            |p| p.fast_cut_ratio = -p.fast_cut_ratio,
            |p| p.csg_op_cap ^= 1,
            |p| p.csg_element_cap ^= 1,
            |p| p.alt_triangulator = !p.alt_triangulator,
        ];
        for (i, change) in variants.iter().enumerate() {
            let mut p = base;
            change(&mut p);
            assert_ne!(p.canonical_bytes(), base.canonical_bytes(), "field {i} not encoded");
        }
    }
}
