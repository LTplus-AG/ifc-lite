// SPDX-License-Identifier: MPL-2.0
//! Owned execution evidence, including refusal and numerical-error paths.
use crate::{BoolFailure, Error};
use ifc_lite_core::IfcType;

/// Reports carried across compilation, thread transfer and evaluation.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConstructionReports {
    pub curve_capped: bool,
    /// Once per face type within this capture scope, matching router TLS policy.
    /// Evaluated batches list execution reports before remaining source-only
    /// reports. Eager admission and numerical execution have separate chronology;
    /// this is not an occurrence-attributed canonical product event stream.
    pub face_refused: Vec<IfcType>,
    /// Cumulative decoder-known refusals at compilation completion. This can
    /// include earlier reads through that decoder; it is not per-root attribution.
    pub decoder_refused_record_ids: Vec<u32>,
}

impl ConstructionReports {
    pub(crate) fn merge(&mut self, other: Self) {
        self.curve_capped |= other.curve_capped;
        for ty in other.face_refused {
            if !self.face_refused.contains(&ty) { self.face_refused.push(ty); }
        }
        self.decoder_refused_record_ids.extend(other.decoder_refused_record_ids);
        self.decoder_refused_record_ids.sort_unstable();
        self.decoder_refused_record_ids.dedup();
    }
}

/// A fresh boolean failure emitted by an executed instruction. Reused result
/// edges can repeat semantic losses in successful root diagnostics separately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConstructionDiagnostic {
    pub source_id: u32,
    pub failure: BoolFailure,
}

/// A failed batch carries evidence and no partial geometry success.
#[derive(Debug, thiserror::Error)]
#[error("Construction execution failed at root {root_source_id:?}, item {failed_source_id:?}: {error}")]
pub struct ConstructionExecutionError {
    pub root_source_id: Option<u32>,
    pub failed_source_id: Option<u32>,
    #[source]
    pub error: Box<Error>,
    /// Fresh failures from instructions actually executed before refusal/error.
    pub diagnostics: Vec<ConstructionDiagnostic>,
    pub reports: ConstructionReports,
}
