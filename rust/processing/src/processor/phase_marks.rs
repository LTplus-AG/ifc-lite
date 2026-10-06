// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Phase boundary markers for deterministic instruction counting (#6958).
//!
//! Each `ProcessingStats` timer edge in the pipeline passes through [`mark`].
//! With the `phase-markers` feature, every edge calls its own never-inlined,
//! empty function. `scripts/perf/instructions.sh` runs the probe under
//! `valgrind --tool=callgrind --dump-before=ifc_lite_processing::*::phase_marks::*`,
//! so callgrind writes one cost dump on entry to each marker: the dump holds
//! exactly the instructions retired since the previous edge, and its
//! `Trigger:` line names the marker that closed the segment. The marker
//! functions do nothing; they exist so callgrind can see the boundaries.
//!
//! Without the feature (every shipped build), [`mark`] is an always-inlined
//! identity and compiles to nothing. The edge value is passed through so a
//! marker sits on the same line as the timer it mirrors.

/// One `ProcessingStats` timer edge, named for where it sits.
#[derive(Clone, Copy)]
pub(super) enum Mark {
    PipelineStart,
    EntityScanEnd,
    LookupStart,
    LookupEnd,
    PreprocessStart,
    PreprocessEnd,
    ParseEnd,
    GeometryStart,
    GeometryEnd,
    TotalEnd,
}

/// Record the phase edge `at`, then return `value` unchanged.
#[cfg(not(feature = "phase-markers"))]
#[inline(always)]
pub(super) fn mark<T>(_at: Mark, value: T) -> T {
    value
}

/// Record the phase edge `at`, then return `value` unchanged.
#[cfg(feature = "phase-markers")]
#[inline(always)]
pub(super) fn mark<T>(at: Mark, value: T) -> T {
    match at {
        Mark::PipelineStart => pipeline_start(),
        Mark::EntityScanEnd => entity_scan_end(),
        Mark::LookupStart => lookup_start(),
        Mark::LookupEnd => lookup_end(),
        Mark::PreprocessStart => preprocess_start(),
        Mark::PreprocessEnd => preprocess_end(),
        Mark::ParseEnd => parse_end(),
        Mark::GeometryStart => geometry_start(),
        Mark::GeometryEnd => geometry_end(),
        Mark::TotalEnd => total_end(),
    }
    value
}

/// One never-inlined function per edge. `black_box` keeps the call from being
/// optimised away, and the distinct tag per function keeps the bodies distinct
/// so identical-function merging cannot fold every edge into one symbol.
#[cfg(feature = "phase-markers")]
macro_rules! edge_functions {
    ($($name:ident = $tag:literal),* $(,)?) => {
        $(
            #[inline(never)]
            fn $name() {
                std::hint::black_box($tag);
            }
        )*
    };
}

#[cfg(feature = "phase-markers")]
edge_functions!(
    pipeline_start = 0u8,
    entity_scan_end = 1u8,
    lookup_start = 2u8,
    lookup_end = 3u8,
    preprocess_start = 4u8,
    preprocess_end = 5u8,
    parse_end = 6u8,
    geometry_start = 7u8,
    geometry_end = 8u8,
    total_end = 9u8,
);
