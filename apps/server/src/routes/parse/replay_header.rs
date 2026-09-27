// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Marking a replayed `X-IFC-Metadata` header as served from cache (#5542).

/// The stored `X-IFC-Metadata` header JSON, with `stats.from_cache` set to
/// `true`.
///
/// The header is cached exactly as the live parse wrote it, and the live parse
/// writes `from_cache: false`, because at that moment it was not. Replaying it
/// verbatim therefore told every warm caller it had just been parsed:
/// `parseParquet()` reported `stats.from_cache === false` on a cache hit
/// (#5542), while `GET /api/v1/cache/{key}` and the JSON parse route both set
/// the flag on theirs.
///
/// Works on the JSON value rather than a typed header so the flat and
/// optimized headers (two different structs) share one rule, and so a field
/// this build does not know about is carried through untouched. A header that
/// is not a JSON object with a `stats` object is returned unchanged: that is
/// what every replay path did before, and the flag is not this function's
/// reason to reject an entry.
pub(crate) fn mark_header_from_cache(header: String) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&header) else {
        return header;
    };
    let Some(stats) = value.get_mut("stats").and_then(serde_json::Value::as_object_mut) else {
        return header;
    };
    stats.insert("from_cache".to_owned(), serde_json::Value::Bool(true));
    serde_json::to_string(&value).unwrap_or(header)
}
