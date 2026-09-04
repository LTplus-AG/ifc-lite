// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `ParseQuery::resolved_tessellation_quality`, in a
//! ratchet-exempt sibling file like every other test module here.

use super::*;
use crate::error::ApiError;

/// Omitting the query parameter must resolve to the documented default
/// (`Medium`, byte-identical to pre-enum behavior) — not silently to some
/// other level. Coverage gap found via mutation testing: swapping this arm
/// to `TessellationQuality::Highest` survived the full `ifc-lite-server`
/// suite (83/83 passed) with zero test hitting this code path.
#[test]
fn none_resolves_to_medium_default() {
    let query = ParseQuery {
        tessellation_quality: None,
        ..Default::default()
    };
    assert_eq!(
        query.resolved_tessellation_quality().unwrap(),
        TessellationQuality::Medium
    );
}

/// Every documented label round-trips through `resolved_tessellation_quality`,
/// case-insensitively.
#[test]
fn every_documented_label_parses() {
    let cases = [
        ("lowest", TessellationQuality::Lowest),
        ("Low", TessellationQuality::Low),
        ("MEDIUM", TessellationQuality::Medium),
        ("high", TessellationQuality::High),
        ("Highest", TessellationQuality::Highest),
    ];
    for (label, expected) in cases {
        let query = ParseQuery {
            tessellation_quality: Some(label.to_string()),
            ..Default::default()
        };
        assert_eq!(
            query.resolved_tessellation_quality().unwrap(),
            expected,
            "label {label:?} should resolve to {expected:?}"
        );
    }
}

/// An unknown level must be rejected as a client error (`400 BadRequest`),
/// not swallowed or reported as a server-side `Internal` error — the two
/// map to different HTTP statuses and log at different severities.
/// Coverage gap found via mutation testing: replacing `ApiError::BadRequest`
/// with `ApiError::Internal` on this arm survived the full suite (83/83
/// passed) — no test asserted the error path at all, let alone which variant.
#[test]
fn unknown_label_is_bad_request_not_internal() {
    let query = ParseQuery {
        tessellation_quality: Some("ultra".to_string()),
        ..Default::default()
    };
    let err = query.resolved_tessellation_quality().unwrap_err();
    match err {
        ApiError::BadRequest(msg) => {
            assert!(
                msg.contains("ultra"),
                "error message should name the rejected value, got: {msg}"
            );
        }
        other => panic!("expected ApiError::BadRequest, got {other:?}"),
    }
}
