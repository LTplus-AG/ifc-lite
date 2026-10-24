// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits};
use crate::router::GeometryProcessor;

const SOURCE: &str = include_str!("../../../tests/fixtures/issue_7714_soffice_carrier.ifc");

#[test]
fn issue_7714_owned_constructor_keeps_normalized_loops_after_source_drops() {
    let plan = {
        let source = ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
        let mut decoder = source.decoder().with_strict_reals();
        let item = decoder.decode_by_id(489635).unwrap();
        let plan = super::super::faceted::FacetedBrepProcessor::new()
            .lower_owned(&item, &mut decoder, crate::TessellationQuality::Medium, None)
            .unwrap().unwrap();
        assert_eq!(decoder.get_cartesian_point_fast(489593).unwrap().0, 95.0001680875);
        plan
    };
    let mesh = plan.evaluate().unwrap();
    assert_eq!(mesh.indices.len() / 3, 16);
    let corners: Vec<_> = mesh.positions.chunks_exact(3)
        .filter(|p| p[1] == 11845.0000131f32 && p[2] == -325. && p[0] < 97.)
        .collect();
    assert!(!corners.is_empty());
    assert!(corners.iter().all(|p| p[0] == 95.));
}

#[test]
fn issue_7714_cancelled_and_strict_execution_stop_before_source_loop_reads() {
    for (policy, cancel) in [
        (ExecutionPolicy::Bounded(ResourceLimits::default()), true),
        (ExecutionPolicy::Strict(ResourceLimits::default()), false),
    ] {
        let mut decoder = EntityDecoder::new(SOURCE);
        let item = decoder.decode_by_id(489635).unwrap();
        let account = ExecutionAccount::new(policy);
        if cancel { account.cancel(); }
        let expected = account.check().unwrap_err();
        account.scope(|| {
            assert!(matches!(super::super::faceted_plan::lower(&item, &mut decoder, None),
                Err(crate::Error::ProgramStopped(stop)) if stop == expected));
        });
        assert_eq!(decoder.point_cache_stats(), (0, 0));
    }
}

#[test]
fn issue_7714_certificate_cannot_normalize_loops_from_another_source() {
    let mut first = EntityDecoder::new(SOURCE);
    let item = first.decode_by_id(489635).unwrap();
    let (shell, _) = read_shell(&item, &mut first).unwrap();
    let mut faces: Vec<_> = shell.faces.iter().map(|ids| FaceData {
        outer_points: ring(&shell, ids).iter().map(exact::rounded).collect::<Option<_>>().unwrap(),
        hole_points: Vec::new(),
    }).collect();
    let foreign = SOURCE.replace("95.0001680875", "95.0002");
    let mut other = EntityDecoder::new(&foreign);
    assert!(normalize(&item, &mut other, &mut faces).unwrap().is_none());
    assert!(faces.iter().flat_map(|f| &f.outer_points).any(|p| p.x == 95.0001680875));
    assert!(!faces.iter().flat_map(|f| &f.outer_points).any(|p| p.x == 95.0002));
}
