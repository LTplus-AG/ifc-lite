// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::ImportIdentity;

fn definition(occurrence: u64) -> ImportedDefinition {
    ImportedDefinition {
        identity: ImportIdentity { store: 5, revision: 7, definition: 1, occurrence },
        source: ImportedSource::Points(vec![1.0 + 2.0_f64.powi(-40), 2.0, 3.0]),
        transform_stack: vec![],
    }
}

#[test]
fn source_independent_program_retains_original_precision_and_real_occurrences() {
    let mut program = ImportedGeometryProgram::new(5, 7, vec![definition(10), definition(11)]).unwrap();
    while let Some(ready) = program.next_operation().unwrap() {
        let result = execute(ready).unwrap();
        program.complete(result).unwrap();
    }
    let output = program.finish().unwrap();
    assert_eq!(output.len(), 2);
    for (index, assembly) in output.iter().enumerate() {
        assert_eq!(assembly.definition.identity.occurrence, 10 + index as u64);
        let ImportedSource::Points(raw) = &assembly.definition.source else { panic!("wrong source"); };
        assert!(raw[0] > 1.0);
        let ImportedOutput::Points(points) = &assembly.output else { panic!("wrong output"); };
        assert_eq!(points.positions, [1.0, 3.0, -2.0]);
    }
}

#[test]
fn foreign_completion_does_not_consume_the_actual_pending_operation() {
    let mut program = ImportedGeometryProgram::single(definition(1));
    let ready = program.next_operation().unwrap().unwrap();
    let result = execute(ready).unwrap();
    for field in 0..4 {
        let mut stale = result.clone();
        match field {
            0 => stale.identity.store += 1,
            1 => stale.identity.revision += 1,
            2 => stale.identity.definition += 1,
            _ => stale.identity.occurrence += 1,
        }
        assert_eq!(program.complete(stale), Err(SceneError::IdentityMismatch));
    }
    assert!(matches!(program.next_operation(), Err(SceneError::OperationPending)));
    program.complete(result).unwrap();
    assert_eq!(program.finish().unwrap().len(), 1);
}

#[test]
fn failures_and_incomplete_work_never_assemble_a_partial_scene() {
    let mut program = ImportedGeometryProgram::new(5, 7, vec![definition(1), definition(2)]).unwrap();
    let result = execute(program.next_operation().unwrap().unwrap()).unwrap();
    program.complete(result).unwrap();
    assert!(matches!(program.finish(), Err(SceneError::Incomplete)));

    let mut failed = ImportedGeometryProgram::single(definition(1));
    failed.next_operation().unwrap();
    failed.fail(ImportError::HomogeneousPoints);
    assert!(matches!(failed.next_operation(), Err(SceneError::Failed(ImportError::HomogeneousPoints))));
    assert!(matches!(failed.finish(), Err(SceneError::Failed(ImportError::HomogeneousPoints))));
}

#[test]
fn duplicate_occurrence_and_foreign_revision_are_rejected_at_admission() {
    assert!(matches!(ImportedGeometryProgram::new(5, 7, vec![definition(1), definition(1)]),
        Err(SceneError::DuplicateOccurrence)));
    assert!(matches!(ImportedGeometryProgram::new(5, 8, vec![definition(1)]),
        Err(SceneError::IdentityMismatch)));
    let program = ImportedGeometryProgram::new(5, 7, vec![]).unwrap();
    assert!(program.finish().unwrap().is_empty());
}

#[test]
fn completion_without_issued_work_is_refused() {
    let mut program = ImportedGeometryProgram::single(definition(1));
    let result = execute(&plan(definition(1))).unwrap();
    assert_eq!(program.complete(result),
        Err(SceneError::NoOperationPending));
}

#[test]
fn different_source_with_identical_public_identity_cannot_complete_an_issued_operation() {
    let mut program = ImportedGeometryProgram::single(definition(1));
    let issued = program.next_operation().unwrap().unwrap();
    let original = execute(issued).unwrap();
    let mut changed = issued.definition().clone();
    changed.source = ImportedSource::Points(vec![42., 2., 3.]);
    let other = plan(changed);
    let forged = execute(&other).unwrap();
    assert_eq!(program.complete(forged), Err(SceneError::IdentityMismatch));
    program.complete(original).unwrap();
    let assembled = program.finish().unwrap();
    let ImportedOutput::Points(output) = &assembled[0].output else { panic!("points"); };
    assert_eq!(output.positions, [1., 3., -2.]);
}
