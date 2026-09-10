// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{SymbolicData, SymbolicFillArea};
use serde::{Serialize, Serializer, ser::{SerializeSeq, SerializeStruct}};

/// Canonical symbol data plus extraction-bound direct fill identities.
/// Private fields preserve freedom to extend this result without breaking
/// callers constructing the legacy `SymbolicData` / `SymbolicFillArea` structs.
#[derive(Debug, Clone, Default)]
pub struct SymbolicDataWithProvenance {
    data: SymbolicData,
    fill_items: Vec<Option<u32>>,
}
impl SymbolicDataWithProvenance {
    pub(super) fn new(data: SymbolicData, fill_items: Vec<Option<u32>>) -> Self {
        Self { data, fill_items }
    }
    /// Legacy data without modifying any public primitive struct.
    pub fn data(&self) -> &SymbolicData { &self.data }
    /// One optional direct item id for each fill, in matching ordinal order.
    pub fn fill_items(&self) -> &[Option<u32>] { &self.fill_items }
    /// Consume the result into legacy data and its ordinal-aligned sidecar.
    pub fn into_parts(self) -> (SymbolicData, Vec<Option<u32>>) { (self.data, self.fill_items) }
    /// Whether no symbolic primitives were extracted.
    pub fn is_empty(&self) -> bool { self.data.is_empty() }
}
#[derive(Serialize)]
struct Fill<'a> {
    #[serde(flatten)]
    fill: &'a SymbolicFillArea,
    #[serde(skip_serializing_if = "Option::is_none")]
    geometry_item_id: Option<u32>,
}
struct Fills<'a>(&'a SymbolicDataWithProvenance);
impl Serialize for Fills<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.0.data.fills.len()))?;
        for (ordinal, fill) in self.0.data.fills.iter().enumerate() {
            seq.serialize_element(&Fill { fill, geometry_item_id: self.0.fill_items.get(ordinal).copied().flatten() })?;
        }
        seq.end()
    }
}
impl Serialize for SymbolicDataWithProvenance {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("SymbolicData", 5 + usize::from(self.data.truncated.is_some()))?;
        out.serialize_field("grid_axes", &self.data.grid_axes)?;
        out.serialize_field("polylines", &self.data.polylines)?;
        out.serialize_field("circles", &self.data.circles)?;
        out.serialize_field("texts", &self.data.texts)?;
        out.serialize_field("fills", &Fills(self))?;
        if let Some(truncated) = &self.data.truncated { out.serialize_field("truncated", truncated)?; }
        out.end()
    }
}

// Deserialize the same JSON shape, including old caches with no provenance.
impl<'de> serde::Deserialize<'de> for SymbolicDataWithProvenance {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(serde::Deserialize)]
        struct OwnedFill {
            #[serde(flatten)]
            fill: SymbolicFillArea,
            #[serde(default)]
            geometry_item_id: Option<u32>,
        }
        #[derive(serde::Deserialize)]
        struct Wire {
            grid_axes: Vec<super::SymbolicGridAxis>,
            polylines: Vec<super::SymbolicPolyline>,
            circles: Vec<super::SymbolicCircle>,
            texts: Vec<super::SymbolicText>,
            fills: Vec<OwnedFill>,
            #[serde(default)]
            truncated: Option<super::SymbolicTruncation>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let (fills, fill_items) = wire.fills.into_iter().map(|f| (f.fill, f.geometry_item_id)).unzip();
        Ok(Self { data: SymbolicData { grid_axes: wire.grid_axes, polylines: wire.polylines,
            circles: wire.circles, texts: wire.texts, fills, truncated: wire.truncated }, fill_items })
    }
}
impl From<SymbolicData> for SymbolicDataWithProvenance {
    fn from(data: SymbolicData) -> Self {
        let fill_items = vec![None; data.fills.len()];
        Self { data, fill_items }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_4459_optional_provenance_preserves_legacy_json_and_nan_sentinels() {
        let old = r#"{"grid_axes":[],"polylines":[],"circles":[],"texts":[],"fills":[{"express_id":1,"ifc_type":"IfcAnnotation","points":[0,0,1,0,0,1],"holes_offsets":[],"fill_color":[1,0,0,1],"has_hatching":false,"hatch_spacing":0,"hatch_angle":0,"hatch_angle_secondary":null,"hatch_line_width":0,"world_y":null,"representation":"Annotation"}]}"#;
        let legacy: SymbolicData = serde_json::from_str(old).unwrap();
        let decoded: SymbolicDataWithProvenance = serde_json::from_str(old).unwrap();
        assert_eq!(decoded.fill_items(), &[None]);
        assert!(decoded.data().fills[0].world_y.is_nan());
        assert_eq!(serde_json::to_value(&decoded).unwrap(), serde_json::to_value(&legacy).unwrap());
        let mut accumulator = super::super::output_cap::SymbolicAccumulator::new();
        let mut invalid = legacy.fills[0].clone();
        invalid.points[0] = f32::NAN;
        accumulator.push_fill_with_provenance(invalid, Some(77));
        accumulator.push_fill_with_provenance(legacy.fills[0].clone(), Some(99));
        let accepted = accumulator.into_provenance();
        assert_eq!(accepted.data().fills.len(), 1);
        assert_eq!(accepted.fill_items(), &[Some(99)], "refused appends cannot shift ordinal provenance");
        let enriched = SymbolicDataWithProvenance::new(legacy, vec![Some(99)]);
        let bytes = serde_json::to_vec(&enriched).unwrap();
        let roundtrip: SymbolicDataWithProvenance = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(roundtrip.fill_items(), &[Some(99)]);
        let old_reader: SymbolicData = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(old_reader.fills.len(), 1);
        assert!(old_reader.fills[0].hatch_angle_secondary.is_nan());
    }
}
