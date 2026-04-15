// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Local stub of the `core2` crate.
//!
//! # Why this exists
//!
//! The upstream `core2` crate on crates.io (a `std::io` polyfill for
//! `no_std`) has had **every published version yanked** by its maintainer.
//! That breaks any fresh dependency resolution that transitively requests
//! `core2 ^0.4`, which for this workspace means `csgrs 0.20.x` —
//! specifically `csgrs`'s non-optional `[dependencies.core2]` entry, which
//! is only used inside the feature-gated `src/io/stl.rs` and `src/io/dxf.rs`
//! modules.
//!
//! `ifc-lite-geometry` enables `csgrs` with `default-features = false,
//! features = ["earcut", "f64"]`. Neither the `stl-io` nor `dxf-io`
//! feature is turned on, so the csgrs source files that actually `use
//! core2::io::Cursor` are never compiled. The only remaining requirement
//! is that cargo can resolve a crate named `core2` at version `^0.4` so the
//! workspace dependency graph is valid.
//!
//! This file is that crate. It intentionally exports nothing — all real
//! `core2` users in our build graph are compiled out by feature flags.
//! The parent workspace redirects references to the published crate via a
//! `[patch.crates-io]` entry.
//!
//! # When to remove this
//!
//! Once `csgrs` upstream either (a) marks `core2` as `optional = true` and
//! gates it behind the `stl-io`/`dxf-io` features, (b) migrates to
//! `core3`, or (c) inlines the tiny amount of `Cursor`/`Read`/`Write` code
//! it needs, this stub and its `[patch.crates-io]` entry can be deleted.

#![no_std]
#![deny(warnings)]
#![forbid(unsafe_code)]

/// Namespace kept so that a hypothetical `use core2::io::*;` elsewhere in
/// the workspace at least parses. No symbols are exported because none are
/// reachable under the features we enable.
pub mod io {}
