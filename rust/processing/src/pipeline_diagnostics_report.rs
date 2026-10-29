// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Extensible v2 wire report; preserve v1's published constructible Rust struct.
use super::PipelineDiagnostics;
use crate::types::response::ProcessingStats;

/// Version 2 of the pipeline diagnostics report, used by `getPipelineDiagnostics`.
/// The v1 `PipelineDiagnostics` remains constructible for existing Rust callers.
/// Construct reports via `Default` or `from_processing_stats`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PipelineDiagnosticsReport {
    #[serde(flatten)]
    pub pipeline: PipelineDiagnostics,
    /// Attempted elements whose own decode or geometry read refused input.
    #[serde(default)]
    pub refused_input_elements: u64,
    /// Distinct records refused in prepass or batch resolution on this worker.
    #[serde(default)]
    pub refused_prepass_records: u64,
}

impl Default for PipelineDiagnosticsReport {
    fn default() -> Self {
        Self {
            pipeline: PipelineDiagnostics {
                schema_version: 2,
                ..Default::default()
            },
            refused_input_elements: 0,
            refused_prepass_records: 0,
        }
    }
}

impl PipelineDiagnosticsReport {
    pub fn from_processing_stats(stats: &ProcessingStats, element_count: u64) -> Self {
        Self {
            pipeline: PipelineDiagnostics {
                schema_version: 2,
                ..PipelineDiagnostics::from_processing_stats(stats, element_count)
            },
            refused_input_elements: stats.refused_input_elements,
            refused_prepass_records: stats.refused_prepass_records,
        }
    }
}

impl std::ops::Deref for PipelineDiagnosticsReport {
    type Target = PipelineDiagnostics;
    fn deref(&self) -> &Self::Target {
        &self.pipeline
    }
}

impl std::ops::DerefMut for PipelineDiagnosticsReport {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.pipeline
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn c4_10a_report_preserves_v1_and_projects_native_refusals_7782() {
        let stats = ProcessingStats {
            refused_input_elements: 2,
            refused_prepass_records: 1,
            ..Default::default()
        };
        let report = PipelineDiagnosticsReport::from_processing_stats(&stats, 3);
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["schemaVersion"], 2);
        assert_eq!(json["refusedInputElements"], 2);
        assert_eq!(json["refusedPrepassRecords"], 1);
        assert_eq!(json["elementCount"], 3);
        assert_eq!(PipelineDiagnostics::default().schema_version, 1);
    }
}
