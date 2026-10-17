/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Wire names, JSON encoding and decoding of [`LandXmlMetadataRecord`].
//!
//! One variant list generates all three, so they cannot drift. Decoding
//! dispatches on the wire name and deserializes each payload through
//! `serde_json::from_value`, rather than through the derived adjacently-tagged
//! `Deserialize` impl: that impl buffers the payload for content-first input
//! and compiles every record type's deserializer twice, which cost ~200 KB of
//! raw wasm (engine-wasm-brotli ratchet).

use super::LandXmlMetadataRecord;

macro_rules! wire_records {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        impl LandXmlMetadataRecord {
            pub(crate) fn wire_name(&self) -> &'static str {
                match self {
                    $(Self::$variant(_) => $name,)+
                }
            }

            pub(crate) fn serialize_value(&self) -> Result<Vec<u8>, serde_json::Error> {
                match self {
                    $(Self::$variant(value) => serde_json::to_vec(value),)+
                }
            }

            /// Inverse of [`Self::wire_name`] + [`Self::serialize_value`].
            pub(crate) fn from_wire(
                name: &str,
                value: serde_json::Value,
            ) -> Result<Self, serde_json::Error> {
                match name {
                    $($name => serde_json::from_value(value).map(Self::$variant),)+
                    other => Err(serde::de::Error::unknown_variant(other, &[$($name),+])),
                }
            }
        }
    };
}

wire_records! {
    TerrainExtension => "terrain_extension",
    TerrainWarning => "terrain_warning",
    TerrainAlignment => "terrain_alignment",
    TerrainProfile => "terrain_profile",
    TerrainCrossSection => "terrain_cross_section",
    TerrainCrossSectionSurface => "terrain_cross_section_surface",
    TerrainRoadway => "terrain_roadway",
    TerrainCapabilityDiagnostic => "terrain_capability_diagnostic",
    TerrainPreservedOnlyExtension => "terrain_preserved_only_extension",
    PlanCogoPoint => "plan_cogo_point",
    PlanMonument => "plan_monument",
    PlanFeature => "plan_feature",
    PlanParcel => "plan_parcel",
    PlanWarning => "plan_warning",
    PlanSourceBatch => "plan_source_batch",
    PlanParcelProbe => "plan_parcel_probe",
    PlanResolvedMonument => "plan_resolved_monument",
    PlanResolvedGeometry => "plan_resolved_geometry",
    AlignmentRenderSpan => "alignment_render_span",
    AlignmentRenderRefusal => "alignment_render_refusal",
    AlignmentRenderTruncated => "alignment_render_truncated",
    HorizontalAlignment => "horizontal_alignment",
    HorizontalAlignmentWarning => "horizontal_alignment_warning",
    PipeCollection => "pipe_collection",
    PipeFeature => "pipe_feature",
    PipePreflightRefusal => "pipe_preflight_refusal",
    PipeNetwork => "pipe_network",
    PipeRefusal => "pipe_refusal",
}

#[cfg(test)]
mod tests {
    use super::LandXmlMetadataRecord;

    #[test]
    fn wire_round_trip_and_unknown_name() {
        let record = LandXmlMetadataRecord::PlanWarning("w".to_owned());
        let bytes = record.serialize_value().unwrap();
        let value = serde_json::from_slice(&bytes).unwrap();
        let back = LandXmlMetadataRecord::from_wire(record.wire_name(), value).unwrap();
        assert!(matches!(back, LandXmlMetadataRecord::PlanWarning(w) if w == "w"));
        let err = LandXmlMetadataRecord::from_wire("nope", serde_json::Value::Null).unwrap_err();
        assert!(err.to_string().contains("unknown variant `nope`"), "{err}");
    }
}
