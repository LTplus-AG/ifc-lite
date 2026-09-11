// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_processing::{ParseResponse, SymbolicDataWithProvenance};
use serde::{Deserialize, Serialize};

/// Server wire extension; the published processing response remains unchanged.
/// The legacy payload must have empty symbolic data, so it contributes no
/// duplicate JSON key. Only this constructor can assemble the wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolicParseResponse {
    #[serde(flatten)]
    response: ParseResponse,
    #[serde(default, skip_serializing_if = "SymbolicDataWithProvenance::is_empty")]
    pub symbolic_data: SymbolicDataWithProvenance,
}
impl SymbolicParseResponse {
    pub fn mark_from_cache(&mut self) { self.response.stats.from_cache = true; }
    pub fn new(mut response: ParseResponse, symbolic_data: SymbolicDataWithProvenance) -> Self {
        response.symbolic_data = Default::default();
        Self { response, symbolic_data }
    }
}
impl std::ops::Deref for SymbolicParseResponse {
    type Target = ParseResponse;
    fn deref(&self) -> &Self::Target { &self.response }
}
