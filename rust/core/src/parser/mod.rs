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
//!
//! [`lexical`] holds one small piece shared by both, and by other crates:
//! [`skip_step_comment`] is the STEP `/* ... */` comment-skip rule, in one
//! place so every scanner that has no reason to answer "what does an
//! unterminated comment mean" differently gives the same answer (#3303).

mod lexical;
mod malformed_records;
mod oversized_ids;
mod scanner;
mod tokenizer;

pub use lexical::skip_step_comment;
pub use malformed_records::{malformed_record_report, report_malformed_records};
pub use oversized_ids::{oversized_id_report, report_oversized_ids, set_report_sink};
pub use scanner::{entity_count, EntityScanner};
pub use tokenizer::{parse_entity, Token};

/// Report both oversized-id refusals and malformed-record stops from a scan.
/// A convenience combining [`report_oversized_ids`] and
/// [`report_malformed_records`] for the many call sites that scan and then
/// report both diagnostics unconditionally.
pub fn report_scan_diagnostics(oversized_count: usize, has_malformed: bool) {
    report_oversized_ids(oversized_count);
    report_malformed_records(has_malformed);
}
