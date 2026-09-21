// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded interoperability policy for non-EXPRESS exporter spellings.
//!
//! Every supported EXPRESS entity is represented by the generated per-schema
//! universe. These three tokens are deliberately the only exception: common
//! exporters instantiate leaves that IFC4X3 models only through their abstract
//! geotechnical-stratum base.

/// Non-EXPRESS exporter spellings accepted as geometry-bearing rooted strata.
pub const EXPORTER_STRATUM_ALIASES: &[&str] = &[
    "IFCSOLIDSTRATUM",
    "IFCVOIDSTRATUM",
    "IFCWATERSTRATUM",
];

/// Whether an uppercase STEP keyword is one of the bounded aliases.
pub fn is_exporter_stratum_alias(keyword: &str) -> bool {
    EXPORTER_STRATUM_ALIASES.contains(&keyword)
}
