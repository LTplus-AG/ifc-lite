// SPDX-License-Identifier: MPL-2.0
//! Admission bootstrap only; the generated decoder remains the schema authority.
use super::SourceInspectionError;
use serde::{de::{Error, Visitor}, Deserialize, Deserializer};

#[derive(Deserialize)]
struct Binding { identity: Identity }
#[derive(Deserialize)]
struct Identity { options: Limits }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Limits {
    #[serde(deserialize_with = "limit")]
    pub(super) max_work: u64,
    #[serde(deserialize_with = "limit")]
    pub(super) max_bytes: u64,
    #[serde(deserialize_with = "limit")]
    pub(super) deadline_ms: u64,
}

pub(super) fn read(json: &str) -> Result<Limits, SourceInspectionError> {
    // The entry caps input at 16 KiB. Only three integers survive this pass:
    // other values use Serde's IgnoredAny, not owned binding fields/collections.
    // Unknown fields are deliberately left to the authoritative strict decode
    // under scratch admission. Duplicate admission fields are rejected by Serde.
    serde_json::from_str::<Binding>(json)
        .map(|binding| binding.identity.options)
        .map_err(|_| SourceInspectionError::InvalidReport)
}

fn limit<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    struct Number;
    impl Visitor<'_> for Number {
        type Value = u64;
        fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("an inspection limit string")
        }
        fn visit_str<E: Error>(self, value: &str) -> Result<u64, E> {
            value.parse().map_err(E::custom)
        }
    }
    // Also accepts JSON escapes without allocating an owned limit String.
    // serde_json's transient escape scratch is bounded by the entry byte cap.
    deserializer.deserialize_str(Number)
}
