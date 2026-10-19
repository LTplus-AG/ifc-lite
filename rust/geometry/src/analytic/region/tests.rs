// SPDX-License-Identifier: MPL-2.0
//! Source-backed foundation invariants. No authenticated common binding, SDK
//! receipt, authored replacement recipe or final product is supplied here.
use super::*;
use crate::analytic::{extract_analytic_profile, AnalyticStatus, SourceValue};
use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ResourceLimits};
use ifc_lite_core::{EntityDecoder, SourceBundle};
use num_traits::{One, Signed};
const SOURCE: &str =
    include_str!("../../../../processing/tests/fixtures/issue_3641_voiding_trap.ifc");
fn capture(source: &str) -> Arc<UntrustedProfileChain> {
    let bundle = SourceBundle::new(source.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(61272).unwrap();
    capture_untrusted_profile_chain(&profile, decoder).unwrap()
}
fn variant(points: &[[f64; 2]], selectors: Option<&str>) -> String {
    let start = SOURCE.find("#61274=").unwrap();
    let end = start + SOURCE[start..].find(';').unwrap() + 1;
    let coordinates = points
        .iter()
        .map(|p| format!("({},{})", p[0], p[1]))
        .collect::<Vec<_>>()
        .join(",");
    let mut source = SOURCE.to_string();
    source.replace_range(
        start..end,
        &format!("#61274=IFCCARTESIANPOINTLIST2D(({coordinates}),$);"),
    );
    let start = source.find("#61273=").unwrap();
    let end = start + source[start..].find(';').unwrap() + 1;
    let default = format!(
        "IFCLINEINDEX(({}))",
        (1..=points.len())
            .chain(std::iter::once(1))
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    source.replace_range(
        start..end,
        &format!(
            "#61273=IFCINDEXEDPOLYCURVE(#61274,({}),$);",
            selectors.unwrap_or(&default)
        ),
    );
    source
}
fn reason(result: Result<UntrustedRegionCertificate, RegionError>) -> RegionRefusal {
    match result {
        Err(RegionError::Unsupported(reason)) => reason,
        _ => panic!("explicit unresolved admission required"),
    }
}
#[test]
fn issue_3641_raw_source_survives_distinct_certified_870mm_region_decomposition() {
    let raw = capture(SOURCE);
    assert_eq!(raw.unit_scale(), 0.001);
    assert_eq!(raw.declared_precision(), Some((0.2, 0.2)));
    assert!(matches!(raw.parse_status(), AnalyticStatus::Complete));
    assert!(matches!(
        raw.original().status,
        AnalyticStatus::Unsupported(_)
    ));
    assert_eq!(raw.original().loops[0].segments.len(), 5);
    let original_record = &raw.profile_source().records[&61272];
    assert_eq!(
        original_record.attributes["OuterCurve"],
        SourceValue::EntityRef(61273)
    );
    let curve_source = raw.original().loops[0].source.as_ref().unwrap();
    assert!(curve_source.records.contains_key(&61273));
    assert!(curve_source.records.contains_key(&61274));
    let certificate =
        regularize_untrusted_lines(Arc::clone(&raw), RegionLimits::default()).unwrap();
    assert!(Arc::ptr_eq(certificate.source(), &raw));
    assert_eq!(certificate.cancellations().len(), 1);
    assert_eq!(certificate.cycle().len(), 4);
    assert_eq!(certificate.spans().len(), 6);
    assert_eq!(
        certificate.signed_double_area(),
        &exact::R::new(6659741963524092375_i64.into(), 1099511627776_i64.into())
    );
    let pair = certificate.cancellations()[0];
    let a = &certificate.spans()[pair[0]];
    let b = &certificate.spans()[pair[1]];
    assert_eq!((a.edge(), b.edge()), (0, 4));
    assert_eq!(a.endpoints(), ([0., 0.], [870., 0.]));
    assert_eq!(b.endpoints(), ([870., 0.], [0., 0.]));
    assert_eq!(
        a.parameters(),
        (&exact::R::from_integer(0.into()), &exact::R::one())
    );
    assert_eq!(b.parameters().0, &exact::R::new(121.into(), 150.into()));
    // Exhaustive partitions and dispositions, independently checked by consumers.
    for edge in 0..5 {
        let spans: Vec<_> = certificate
            .spans()
            .iter()
            .filter(|span| span.edge() == edge)
            .collect();
        assert_eq!(spans[0].parameters().0, &exact::R::from_integer(0.into()));
        assert_eq!(spans.last().unwrap().parameters().1, &exact::R::one());
        for adjacent in spans.windows(2) {
            assert_eq!(adjacent[0].parameters().1, adjacent[1].parameters().0);
        }
    }
    let mut used = certificate.cycle().to_vec();
    used.extend(certificate.cancellations().iter().flatten());
    used.sort_unstable();
    assert_eq!(used, (0..certificate.spans().len()).collect::<Vec<_>>());
    for (&i, &j) in certificate
        .cycle()
        .iter()
        .zip(certificate.cycle().iter().cycle().skip(1))
    {
        assert_eq!(
            certificate.spans()[i].endpoints().1,
            certificate.spans()[j].endpoints().0
        );
    }
    let again = regularize_untrusted_lines(Arc::clone(&raw), RegionLimits::default()).unwrap();
    assert_ne!(certificate.id(), again.id());
    assert_eq!(certificate.cycle(), again.cycle());
    assert_eq!(certificate.signed_double_area(), again.signed_double_area());
    assert!(
        matches!(raw.original().status, AnalyticStatus::Unsupported(_)),
        "derived success never relabels original source"
    );
    let bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(61272).unwrap();
    let legacy = extract_analytic_profile(&profile, &mut decoder);
    assert!(legacy.loops.is_empty());
    assert_eq!(
        legacy.status,
        raw.original().status,
        "legacy extraction stays unchanged"
    );
}
#[test]
fn region_crossing_multiplicity_branching_and_curves_remain_explicit_refusals() {
    let crossing = variant(&[[0., 0.], [4., 4.], [0., 3.], [4., 0.], [5., -1.]], None);
    assert_eq!(
        reason(regularize_untrusted_lines(
            capture(&crossing),
            RegionLimits::default()
        )),
        RegionRefusal::Crossing
    );
    let doubled = variant(
        &[
            [0., 0.],
            [4., 0.],
            [4., 4.],
            [0., 4.],
            [0., 0.],
            [4., 0.],
            [4., 4.],
            [0., 4.],
        ],
        None,
    );
    assert_eq!(
        reason(regularize_untrusted_lines(
            capture(&doubled),
            RegionLimits::default()
        )),
        RegionRefusal::Multiplicity
    );
    let branching = variant(
        &[
            [0., 0.],
            [4., 0.],
            [4., 4.],
            [0., 4.],
            [0., 0.],
            [-4., 0.],
            [-4., -4.],
            [0., -4.],
        ],
        None,
    );
    assert_eq!(
        reason(regularize_untrusted_lines(
            capture(&branching),
            RegionLimits::default()
        )),
        RegionRefusal::Branching
    );
    let curved = variant(
        &[[0., 0.], [1., -1.], [2., 0.], [2., 3.], [0., 3.]],
        Some("IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,4,5,1))"),
    );
    assert_eq!(
        reason(regularize_untrusted_lines(
            capture(&curved),
            RegionLimits::default()
        )),
        RegionRefusal::Curved
    );
}
#[test]
fn unchanged_context_precision_remains_a_second_gate_on_derived_cycles() {
    let source = variant(
        &[[0., 0.], [0.1, 0.], [2., -0.1], [4., -0.1], [4., 0.]],
        None,
    );
    assert!(matches!(
        reason(regularize_untrusted_lines(
            capture(&source),
            RegionLimits::default()
        )),
        RegionRefusal::Topology(_)
    ));
}
#[test]
fn shared_raw_and_derived_permits_follow_lifetimes_without_deep_clones() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(32 * 1024 * 1024),
        ..Default::default()
    }));
    let raw = account.scope(|| capture(SOURCE));
    let source_bytes = account.usage().live_bytes;
    assert!(source_bytes > 0);
    let foreign = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    foreign.cancel();
    let cert = foreign
        .scope(|| regularize_untrusted_lines(Arc::clone(&raw), RegionLimits::default()))
        .unwrap();
    assert!(account.usage().live_bytes > source_bytes);
    drop(raw);
    assert_eq!(cert.source().original().profile_id, 61272);
    assert!(account.usage().live_bytes > source_bytes);
    drop(cert);
    assert_eq!(account.usage().live_bytes, 0);
}
#[test]
fn source_growth_work_bit_growth_and_cancellation_have_typed_first_faults() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0),
        ..Default::default()
    }));
    let bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(61272).unwrap();
    let result = account.scope(|| capture_untrusted_profile_chain(&profile, decoder));
    assert!(
        matches!(result,Err(RegionError::Stopped(resource::ProgramStop::ResourceRefused(f))) if f.dimension==Dimension::LiveBytes)
    );
    assert_eq!(account.usage().work, 0);
    assert_eq!(account.usage().copy_bytes, 0);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let raw = account.scope(|| capture(SOURCE));
    let result = regularize_untrusted_lines(Arc::clone(&raw), RegionLimits { work: 0 });
    let Err(RegionError::Stopped(stop)) = result else {
        panic!("work stop")
    };
    assert!(
        matches!(stop,resource::ProgramStop::ResourceRefused(f) if f.dimension==Dimension::Work)
    );
    account.cancel();
    assert_eq!(account.check(), Err(stop));
    assert!(
        matches!(regularize_untrusted_lines(raw,RegionLimits::default()),Err(RegionError::Stopped(actual)) if actual==stop)
    );
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let raw = account.scope(|| capture(SOURCE));
    account.cancel();
    assert!(matches!(
        regularize_untrusted_lines(raw, RegionLimits::default()),
        Err(RegionError::Stopped(resource::ProgramStop::Cancelled))
    ));
    // The exact arithmetic tier rejects operand bit growth BEFORE multiplication.
    let mut budget = exact::Budget::new(RegionLimits::default());
    let mut x = budget.r(f64::MAX).unwrap();
    loop {
        match budget.mul(&x, &x) {
            Ok(next) => x = next,
            Err(RegionError::Stopped(resource::ProgramStop::ResourceRefused(f))) => {
                assert_eq!(f.dimension, Dimension::Representation);
                break;
            }
            _ => panic!("bit bound"),
        }
    }
}

#[test]
fn source_fill_policy_and_hole_scope_are_never_inferred_from_area_alone() {
    let curve = SOURCE.replace(
        "IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'BL25632'",
        "IFCARBITRARYCLOSEDPROFILEDEF(.CURVE.,'BL25632'",
    );
    assert_eq!(
        reason(regularize_untrusted_lines(
            capture(&curve),
            RegionLimits::default()
        )),
        RegionRefusal::FillPolicy
    );
    let holes = SOURCE.replace(
        "#61272=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'BL25632',#61273);",
        "#61272=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,'BL25632',#61273,(#5012));",
    );
    let bundle = SourceBundle::new(holes.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(61272).unwrap();
    assert!(matches!(
        capture_untrusted_profile_chain(&profile, decoder),
        Err(RegionError::Unsupported(RegionRefusal::MultipleLoops))
    ));
}

#[test]
fn actual_model_simple_control_preserves_source_geometry_and_zero_cancellations() {
    let bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(524).unwrap();
    let raw = capture_untrusted_profile_chain(&profile, decoder).unwrap();
    assert!(matches!(raw.original().status, AnalyticStatus::Complete));
    let cert = regularize_untrusted_lines(Arc::clone(&raw), RegionLimits::default()).unwrap();
    assert_eq!(cert.source().id(), raw.id());
    assert!(cert.cancellations().is_empty());
    assert_eq!(cert.cycle().len(), 4);
    for &i in cert.cycle() {
        assert_eq!(
            cert.spans()[i].parameters(),
            (&exact::R::from_integer(0.into()), &exact::R::one())
        );
    }
    let mut decoder = EntityDecoder::new(SOURCE);
    let legacy = extract_analytic_profile(&profile, &mut decoder);
    assert_eq!(&legacy, raw.original());
}

#[test]
fn unbounded_decoder_coverage_is_typed_refusal_before_profile_chain_reads() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let profile = decoder.decode_by_id(61272).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let result = account.scope(|| capture_untrusted_profile_chain(&profile, decoder));
    assert!(
        matches!(result,Err(RegionError::Stopped(resource::ProgramStop::ResourceRefused(f)))
        if f.dimension==Dimension::Coverage)
    );
    assert_eq!(account.usage().work, 0);
    assert_eq!(account.usage().copy_bytes, 0);
    assert_eq!(account.usage().live_bytes, 0);
}

#[test]
fn full_reversed_spur_and_reversed_outer_orientation_have_complete_lineage() {
    let points = [[0., 0.], [4., 0.], [4., 4.], [0., 4.], [0., 0.], [-4., 0.]];
    for points in [points.to_vec(), points.into_iter().rev().collect()] {
        let source = variant(&points, None);
        let raw = capture(&source);
        assert!(matches!(
            raw.original().status,
            AnalyticStatus::Unsupported(_)
        ));
        let cert = regularize_untrusted_lines(raw, RegionLimits::default()).unwrap();
        assert_eq!(cert.spans().len(), 6);
        assert_eq!(cert.cycle().len(), 4);
        assert_eq!(cert.cancellations().len(), 1);
        assert_eq!(cert.policy_version(), REGION_POLICY_VERSION);
        let pair = cert.cancellations()[0];
        let a = &cert.spans()[pair[0]];
        let b = &cert.spans()[pair[1]];
        assert_eq!(a.endpoints().0, b.endpoints().1);
        assert_eq!(a.endpoints().1, b.endpoints().0);
        for span in [a, b] {
            assert_eq!(
                span.parameters(),
                (&exact::R::from_integer(0.into()), &exact::R::one())
            );
        }
        assert_eq!(
            cert.signed_double_area().abs(),
            exact::R::from_integer(32.into())
        );
    }
}

#[test]
fn bounded_pair_work_refuses_before_arrangement_backing_growth() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let raw = account.scope(|| capture(SOURCE));
    let before = account.usage();
    let result = regularize_untrusted_lines(raw, RegionLimits { work: 2 });
    assert!(
        matches!(result,Err(RegionError::Stopped(resource::ProgramStop::ResourceRefused(f)))
        if f.dimension==Dimension::Work)
    );
    let after = account.usage();
    assert_eq!(after.peak_live_bytes, before.peak_live_bytes);
    assert_eq!(after.live_bytes, 0);
}

#[test]
fn parsing_refusal_keeps_original_coefficients_without_manufacturing_a_region() {
    let source = variant(&[[0., 0.], [4., 0.], [0., 0.], [-4., 0.]], None);
    let raw = capture(&source);
    assert!(matches!(raw.parse_status(), AnalyticStatus::Unsupported(_)));
    assert!(raw.original().loops.is_empty());
    assert!(raw.profile_source().records.contains_key(&61273));
    assert!(raw.profile_source().records.contains_key(&61274));
    assert!(matches!(
        reason(regularize_untrusted_lines(raw, RegionLimits::default())),
        RegionRefusal::Source(_)
    ));
}

#[test]
fn lazy_decoder_metadata_work_is_admitted_before_new_record_backing() {
    let bundle = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = bundle.decoder();
    let profile = decoder.decode_by_id(61272).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(MAX_REGION_WORK),
        ..Default::default()
    }));
    let result = account.scope(|| capture_untrusted_profile_chain(&profile, decoder));
    assert!(
        matches!(result,Err(RegionError::Stopped(resource::ProgramStop::ResourceRefused(f)))
        if f.dimension==Dimension::Work)
    );
    assert_eq!(account.usage().work, 0);
    assert_eq!(account.usage().copy_bytes, 0);
    assert_eq!(account.usage().live_bytes, 0);
}
