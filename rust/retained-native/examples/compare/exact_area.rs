// SPDX-License-Identifier: MPL-2.0
//! Preregistered hand areas for cut products with no analytic face oracle (#7955). They
//! can only name an exact-engine area defect, never excuse retained: see `Report`.
use serde::Deserialize;
use std::collections::BTreeMap;
pub const REGISTERED: &str = include_str!("../../../../tests/fixtures/cli-retained/exact-area-authorities.json");
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry { area: f64, derivation: String }
#[derive(Default)]
pub struct ExactAreaAuthorities { rows: BTreeMap<String, BTreeMap<u32, f64>> }
impl ExactAreaAuthorities {
    pub fn parse(text: &str) -> Result<Self, String> {
        let table: BTreeMap<String, BTreeMap<u32, Entry>> = serde_json::from_str(text).map_err(|e| format!("malformed exact-area authorities: {e}"))?;
        let mut rows = BTreeMap::new();
        for (path, products) in table {
            if !path.starts_with("tests/models/") { return Err(format!("invalid exact-area fixture {path}")); }
            let mut areas = BTreeMap::new();
            for (id, entry) in products {
                if !entry.area.is_finite() || entry.area <= 0. || entry.derivation.trim().is_empty() {
                    return Err(format!("invalid exact-area entry {path}:{id}"));
                }
                areas.insert(id, entry.area);
            }
            rows.insert(path, areas);
        }
        Ok(Self { rows })
    }
    /// The corpus runs from any checkout, so a row matches the model path's repo suffix.
    pub fn get(&self, model: &str, id: u32) -> Option<f64> {
        let model = model.replace('\\', "/");
        self.rows.iter().find(|(path, _)| model.ends_with(path.as_str()))?.1.get(&id).copied()
    }
}
