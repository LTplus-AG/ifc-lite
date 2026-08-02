// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Plato-generated clash math.
//!
//! `plato.rs` is emitted from `tools/plato/clash_math.plato` and must never be
//! hand-edited (regenerate the source instead). It is the single definition of
//! the `Vec3`/`Box3` value types and their operations; the crate's `vec3`,
//! `aabb` and `triangle` modules are thin, byte-compatible adapters over it.

pub mod plato;
