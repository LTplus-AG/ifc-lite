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
//! [`keyword`] is the other shared rule: the scanner returns the keyword as
//! written and STEP keyword case is not significant, so every comparison
//! against a literal goes through [`keyword_eq`] and its siblings.

mod keyword;
mod lexical;
mod malformed_records;
mod oversized_ids;
mod report_sink;
mod scanner;
mod tokenizer;

pub use keyword::{find_keyword, keyword_ends_with, keyword_eq, keyword_starts_with};
pub use lexical::skip_step_comment;
// The one STEP whitespace set, for the raw-byte readers in `decoder` (#3733).
pub(crate) use lexical::is_step_space;
pub use malformed_records::report_malformed_records;
pub use oversized_ids::{oversized_id_report, report_oversized_ids, set_report_sink};
pub use scanner::{entity_count, EntityScanner};
pub use tokenizer::{parse_entity, Token};

/// [`report_oversized_ids`] + [`report_malformed_records`] in one call — the
/// two diagnostics every whole-file `EntityScanner` walk in this workspace
/// emits after a scan, so every call site needs only one line, not two.
pub fn report_scan_diagnostics(skipped_oversized_ids: usize, malformed_record_found: bool) {
    report_oversized_ids(skipped_oversized_ids);
    report_malformed_records(malformed_record_found);
}
