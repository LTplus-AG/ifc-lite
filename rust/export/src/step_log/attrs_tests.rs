// SPDX-License-Identifier: MPL-2.0
//! Tests for `attrs.rs`, split out under the house pattern (AGENTS.md).

use super::*;

/// F4 M-export-a (CORE-6): `serializeAttributeValue` recognises a number by
/// core's one grammar, in the value AND in the token it replaces. The regex
/// port refused `.5`, `+1`, `1.E5`, `+1.` and `-0.`, so a slot already written
/// that way was rewritten as a quoted string. These rows are mirrored, with
/// the same expected text, in `packages/export/src/step-serialization.test.ts`.
#[test]
fn attribute_value_reads_numbers_by_the_core_grammar() {
    for (value, current, expected) in [
        ("3", ".5", "3."),
        (".5", "1", "0.5"),
        ("+1", "2", "1"),
        ("1.E5", "2.", "100000."),
        ("2.5", "+1.", "2.5"),
        ("7", "1.E3", "7."),
        ("1E400", "2", "$"),
        ("1..2", "2", "'1..2'"),
        ("12abc", "2", "'12abc'"),
        ("5", "'x'", "'5'"),
        ("5", "$", "'5'"),
    ] {
        assert_eq!(attribute_value(value, current), expected, "{value} over {current}");
    }
}
