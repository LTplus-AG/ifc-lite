// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `resolve_request_cache_key`, the one resolver behind `GET` and `DELETE
//! /api/v1/cache/{key}` (#5750). The route-level tests beside this file drive
//! it through real requests; these pin the key space itself.

use super::*;

const DIGEST: &str = "71c9466bf02306be58d45b77d738541a0e7410767960b5eed1cf85737dfa34c9";

/// Every key the parse routes can hand a client resolves, to the digest it
/// was built from and to the entry `POST /api/v1/parse` stores under it.
/// Built with the writer's own `cache_key_from_parts`, so a new suffix shape
/// there that the resolver does not accept fails here.
#[test]
fn issue_5750_every_key_the_writer_builds_resolves() {
    for filter in opening_filters() {
        for quality in tessellation_qualities() {
            let key = cache_key_from_parts(DIGEST, filter, quality);
            let resolved = resolve_request_cache_key(&key)
                .unwrap_or_else(|_| panic!("{key} is a request cache_key and must resolve"));
            assert_eq!(resolved.file_digest(), DIGEST);
            assert_eq!(resolved.json_response_key(), json_response_cache_key(&key));
        }
    }
}

/// The spellings a caller might reasonably try that are NOT the request key.
/// A bare digest is what `DELETE` took before #5750; the suffixed storage keys
/// are what `GET` took before #5542. Each would put the two routes back in
/// different key spaces.
#[test]
fn issue_5750_anything_else_is_refused() {
    let refused = [
        String::new(),
        "not-a-key".to_owned(),
        DIGEST.to_owned(),
        format!("{DIGEST}-"),
        format!("{DIGEST}-default-json-v5"),
        format!("{DIGEST}-default-parquet-v5"),
        format!("{DIGEST}-default-qmedium"),
        format!("{DIGEST}-default-qbogus"),
        format!("{DIGEST}-bogus"),
        format!("{DIGEST}-Default"),
        format!("{DIGEST}default"),
        format!("{}-default", DIGEST.to_ascii_uppercase()),
        format!("{}-default", &DIGEST[..63]),
        format!("{DIGEST}0-default"),
        // A multi-byte char straddling byte 64 must be refused, not panic on
        // the slice.
        format!("{}é-default", &DIGEST[..63]),
    ];
    for key in &refused {
        let error = resolve_request_cache_key(key).expect_err(key);
        assert!(matches!(error, ApiError::BadRequest(_)), "{key:?}: {error:?}");
    }
}
