// SPDX-License-Identifier: MPL-2.0
//! Ownership and occurrence invariants using actual placed custom geometry.
use super::*;
use crate::program::tests::{ObservedBlock, BLOCK};
use crate::{GeometryRouter, TessellationQuality};
use ifc_lite_core::EntityDecoder;
use std::{cell::Cell, rc::Rc};

fn source() -> String {
    format!(
        "{BLOCK}
#1=IFCWALL('host',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));
#20=IFCOPENINGELEMENT('opening',$,$,$,$,$,#2,$);"
    )
}

#[test]
fn opening_occurrences_preserve_real_selected_callbacks_and_quiet_diagnostics() {
    let calls = Rc::new(Cell::new(0));
    let mut router = GeometryRouter::new();
    router.register(Box::new(ObservedBlock {
        calls: calls.clone(),
        repair: false,
    }));
    let content = source();
    let mut decoder = EntityDecoder::new(&content);
    let host = decoder.decode_by_id(1).unwrap();
    let recorded = Classifier::new(&host, &[20, 20], true).run(&router, &mut decoder).unwrap();
    assert_eq!(
        recorded.len(),
        2,
        "repeated source IDs remain two occurrences"
    );
    assert_eq!(
        calls.get(),
        6,
        "body, bounds and mesh each use the actual selected processor"
    );
    let quiet = Classifier::new(&host, &[20, 20], false).run(&router, &mut decoder).unwrap();
    assert_eq!(quiet.len(), 2);
    assert_eq!(
        calls.get(),
        12,
        "quiet residual probes repeat callbacks rather than memoizing by ID"
    );
    let counts = router.take_classification_stats();
    assert_eq!(
        counts.rectangular + counts.diagonal + counts.non_rectangular,
        2
    );
    let diagnostics = router.take_host_opening_diagnostics();
    let openings = &diagnostics[&1].openings;
    assert_eq!(
        openings.iter().map(|o| o.opening_id).collect::<Vec<_>>(),
        [20, 20]
    );
    assert!(openings.iter().all(|o| o.vertex_count > 0));
}

#[test]
fn ready_opening_operation_outlives_decoder_and_preserves_consumed_host() {
    let router = GeometryRouter::new();
    let (mesh, context) = {
        let content = source();
        let mut decoder = EntityDecoder::new(&content);
        let host = decoder.decode_by_id(1).unwrap();
        let mesh = router.process_element(&host, &mut decoder).unwrap();
        assert!((crate::mesh_check::signed_volume(&mesh).abs() - 24.).abs() < 1e-6);
        let context =
            crate::program::ProductProgram::host_openings(&host, &[20]).run(&router, &mut decoder).unwrap();
        (mesh, context)
    };
    let result = execute::ReadyOperation::new(
        mesh,
        std::sync::Arc::new(context),
        1,
        TessellationQuality::default(),
        crate::router::voids::numerical_configuration(),
    )
    .execute()
    .publish(&router).unwrap();
    assert!(
        result.is_empty(),
        "the actual containing cutter consumes the host"
    );
    assert!(router.host_consumed_by_void(1));
    let diagnostics = router.take_host_opening_diagnostics();
    assert_eq!(
        diagnostics[&1].openings.len(),
        1,
        "numerical publication does not reclassify"
    );
}
