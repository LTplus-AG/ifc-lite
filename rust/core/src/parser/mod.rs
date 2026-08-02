// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! STEP/IFC Parser using nom
//!
//! Zero-copy tokenization and fast entity scanning.
//!
//! Two independent algorithms live here:
//! - [`tokenizer`]: nom-combinator tokenization ([`Token`], [`parse_entity`]).
//! - [`scanner`]: a byte-level SIMD fast scanner ([`EntityScanner`]) that does
//!   its own hand-rolled parsing and never touches [`Token`] or nom.

mod scanner;
mod tokenizer;

pub use scanner::{entity_count, EntityScanner};
pub use tokenizer::{parse_entity, Token};
