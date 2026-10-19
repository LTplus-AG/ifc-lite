// This Source Code Form is subject to the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ordered, source-independent imported operation owner. Source composition and
//! codecs supply definitions; this owner issues work and accepts only its own
//! outstanding operation. No decoder, source callback or borrowed buffer survives
//! admission. The original f64 source remains alongside assembled display data.

use std::collections::{HashSet, VecDeque};
use crate::{assemble, execute, plan, ExecutedOperation, ImportError, ImportedAssembly,
    ImportedDefinition, ImportedOutput, ImportedSource, ReadyOperation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SceneError {
    IdentityMismatch,
    DuplicateOccurrence,
    OperationPending,
    NoOperationPending,
    Incomplete,
    Failed(ImportError),
}

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::IdentityMismatch => f.write_str("Imported scene: stale store, revision or operation"),
            Self::DuplicateOccurrence => f.write_str("Imported scene: duplicate occurrence identity"),
            Self::OperationPending => f.write_str("Imported scene: an operation is already pending"),
            Self::NoOperationPending => f.write_str("Imported scene: no operation is pending"),
            Self::Incomplete => f.write_str("Imported scene: assembly is incomplete"),
            Self::Failed(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for SceneError {}

/// All output is held until successful completion; an error cannot publish a
/// partially imported scene. Native and generated hosts use the same owner.
#[derive(Debug)]
pub struct ImportedGeometryProgram {
    store: u64,
    revision: u64,
    definitions: VecDeque<ImportedDefinition>,
    pending: Option<ReadyOperation>,
    assemblies: Vec<ImportedAssembly>,
    failure: Option<ImportError>,
}

impl ImportedGeometryProgram {
    pub fn new(store: u64, revision: u64, definitions: Vec<ImportedDefinition>) -> Result<Self, SceneError> {
        let mut occurrences = HashSet::new();
        for definition in &definitions {
            let identity = definition.identity;
            if identity.store != store || identity.revision != revision {
                return Err(SceneError::IdentityMismatch);
            }
            // One definition may be reached by multiple real traversal edges.
            // Occurrence identity, rather than definition identity, is unique.
            if !occurrences.insert(identity.occurrence) {
                return Err(SceneError::DuplicateOccurrence);
            }
        }
        Ok(Self { store, revision, definitions: definitions.into(), pending: None,
            assemblies: Vec::new(), failure: None })
    }

    pub fn single(definition: ImportedDefinition) -> Self {
        Self { store: definition.identity.store, revision: definition.identity.revision,
            definitions: VecDeque::from([definition]), pending: None,
            assemblies: Vec::new(), failure: None }
    }

    /// The owner keeps the Ready alive. A caller can execute it after releasing
    /// all format-adapter buffers; completion never accepts caller-supplied source.
    pub fn next_operation(&mut self) -> Result<Option<&ReadyOperation>, SceneError> {
        self.check_failure()?;
        if self.pending.is_some() { return Err(SceneError::OperationPending); }
        self.pending = self.definitions.pop_front().map(plan);
        Ok(self.pending.as_ref())
    }

    /// A stale/foreign completion is refused without consuming the issued work.
    /// Variant matching prevents a points result replacing an admitted mesh.
    pub fn complete(&mut self, executed: ExecutedOperation) -> Result<(), SceneError> {
        self.check_failure()?;
        let pending = self.pending.as_ref().ok_or(SceneError::NoOperationPending)?;
        if !std::sync::Arc::ptr_eq(&pending.seal, &executed.seal) { return Err(SceneError::IdentityMismatch); }
        let identity = pending.definition.identity;
        if executed.identity != identity || identity.store != self.store || identity.revision != self.revision {
            return Err(SceneError::IdentityMismatch);
        }
        let same_kind = matches!((&pending.definition.source, &executed.output),
            (ImportedSource::Mesh(_), ImportedOutput::Mesh(_)) |
            (ImportedSource::Points(_), ImportedOutput::Points(_)));
        if !same_kind { return Err(SceneError::IdentityMismatch); }
        let pending = self.pending.take().ok_or(SceneError::NoOperationPending)?;
        self.assemblies.push(assemble(pending, executed).map_err(SceneError::Failed)?);
        Ok(())
    }

    pub fn fail(&mut self, error: ImportError) {
        if self.failure.is_none() { self.failure = Some(error); }
        self.pending = None;
        self.definitions.clear();
        self.assemblies.clear();
    }

    pub fn finish(self) -> Result<Vec<ImportedAssembly>, SceneError> {
        self.check_failure()?;
        if self.pending.is_some() || !self.definitions.is_empty() { return Err(SceneError::Incomplete); }
        Ok(self.assemblies)
    }

    fn check_failure(&self) -> Result<(), SceneError> {
        match &self.failure {
            Some(error) => Err(SceneError::Failed(error.clone())),
            None => Ok(()),
        }
    }
}

/// Packet and native entry share the actual plan/execute/complete path.
pub fn evaluate(definition: ImportedDefinition) -> Result<ImportedAssembly, ImportError> {
    let mut program = ImportedGeometryProgram::single(definition);
    let ready = program.next_operation().map_err(|_| ImportError::IdentityMismatch)?
        .ok_or(ImportError::IdentityMismatch)?;
    let result = execute(ready)?;
    program.complete(result).map_err(|_| ImportError::IdentityMismatch)?;
    program.finish().map_err(|_| ImportError::IdentityMismatch)?
        .pop().ok_or(ImportError::IdentityMismatch)
}

#[cfg(test)]
#[path = "scene_tests.rs"]
mod tests;
