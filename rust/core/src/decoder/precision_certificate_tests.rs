// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use std::sync::Arc;

const SOURCE: &str =
    include_str!("../../../geometry/tests/fixtures/issue_7714_soffice_carrier.ifc");

#[test]
fn issue_7714_certificate_resolves_explicit_units_and_inherited_context() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let c = decoder
        .uniform_context_precision()
        .expect("uniform authored context");
    assert_eq!((c.project, c.root_context, c.length_unit), (86, 83, 31));
    assert_eq!(c.contexts, [83, 158]);
    assert_eq!(c.metres_per_unit, 0.001);
    assert_eq!(c.precision, 0.01);
    assert_eq!(decoder.uniform_context_precision().unwrap().precision, 0.01);
}

#[test]
fn issue_7714_uniform_certificate_declines_incomplete_or_conflicting_provenance() {
    let variants = [
        SOURCE.replace("3,0.01,#80", "3,$,#80"),
        SOURCE.replace("3,0.01,#80", "3,0.,#80"),
        SOURCE.replace("3,0.01,#80", "3,-0.01,#80"),
        SOURCE.replace("3,0.01,#80", "2,0.01,#80"),
        SOURCE.replace(".MILLI.", ".UNKNOWN."),
        SOURCE.replace(".METRE.", ".SECOND."),
        SOURCE.replace("(#31)", "()"),
        SOURCE.replace("(#31)", "(#31,#31)"),
        SOURCE.replace("(#83),#70", "(#158),#70"),
        SOURCE.replace("*,*,*,*,#83", "*,*,*,*,#158"),
        SOURCE.replace("*,*,*,*,#83", "*,*,*,*,#99999"),
        SOURCE.replace("*,*,*,*,#83", "*,0.01,*,*,#83"),
        SOURCE.replace(
            "IFCSHAPEREPRESENTATION(#158",
            "IFCSHAPEREPRESENTATION(#99999",
        ),
        SOURCE.replace(
            "ENDSEC;END-ISO",
            "#99=IFCGEOMETRICREPRESENTATIONCONTEXT($,$,3,0.01,#80,$);ENDSEC;END-ISO",
        ),
        SOURCE.replace(
            "ENDSEC;END-ISO",
            "#99=IFCPROJECT($,$,$,$,$,$,$,(#83),#70);ENDSEC;END-ISO",
        ),
        SOURCE.replace(
            "ENDSEC;END-ISO",
            "#99=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#81,2.,$);ENDSEC;END-ISO",
        ),
    ];
    for (i, source) in variants.iter().enumerate() {
        let mut decoder = EntityDecoder::new(source);
        assert!(decoder.uniform_context_precision().is_none(), "variant {i}");
        assert!(
            decoder.uniform_context_precision().is_none(),
            "cached refusal {i}"
        );
    }
}

#[test]
fn issue_7714_context_parent_must_be_the_owned_root() {
    let source = SOURCE.replace("*,*,*,*,#83", "*,*,*,*,#159").replace(
        "#900001=",
        "#159=IFCGEOMETRICREPRESENTATIONSUBCONTEXT($,$,*,*,*,*,#83,$,.MODEL_VIEW.,$);\n#900001=",
    );
    assert!(
        EntityDecoder::new(&source)
            .uniform_context_precision()
            .is_none(),
        "EXPRESS ParentNoSub"
    );
    let cycle = source.replace("*,*,*,*,#83", "*,*,*,*,#158");
    assert!(EntityDecoder::new(&cycle)
        .uniform_context_precision()
        .is_none());
}

#[test]
fn issue_7714_material_wrappers_do_not_supply_context_of_items() {
    let source = SOURCE.replace(
        "ENDSEC;END-ISO",
        "#99=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#900001),$);ENDSEC;END-ISO",
    );
    assert!(EntityDecoder::new(&source)
        .uniform_context_precision()
        .is_some());
}

#[test]
fn issue_7714_monetary_and_derived_units_do_not_read_named_unit_slots() {
    let source = SOURCE.replace("(#31)", "(#31,#98,#99)").replace(
        "ENDSEC;END-ISO",
        "#98=IFCDERIVEDUNIT((),.USERDEFINED.,'test');#99=IFCMONETARYUNIT(.EUR.);ENDSEC;END-ISO",
    );
    assert_eq!(
        EntityDecoder::new(&source)
            .uniform_context_precision()
            .unwrap()
            .length_unit,
        31
    );
}

#[test]
fn issue_7714_certificate_declines_wrong_entity_kinds_without_panicking() {
    let variants = [
        SOURCE.replace(
            "IFCAXIS2PLACEMENT3D(#81,$,$)",
            "IFCAXIS2PLACEMENT3D(#31,$,$)",
        ),
        SOURCE.replace(
            "IFCAXIS2PLACEMENT3D(#81,$,$)",
            "IFCAXIS2PLACEMENT3D(#81,#31,$)",
        ),
        SOURCE.replace("(#31)", "(#31,#81)"),
        SOURCE.replace("(#31)", "(#31,#98)").replace(
            "ENDSEC;END-ISO",
            "#98=IFCSIUNIT(*,$,$,.SECOND.);ENDSEC;END-ISO",
        ),
    ];
    for (index, source) in variants.iter().enumerate() {
        assert!(
            EntityDecoder::new(source)
                .uniform_context_precision()
                .is_none(),
            "malformed provenance {index}"
        );
    }
}

#[test]
fn issue_7714_fresh_concurrent_decoders_scan_once_for_certificate_or_decline() {
    for (source, accepted) in [
        (SOURCE.to_string(), true),
        (SOURCE.replace("3,0.01,#80", "3,$,#80"), false),
    ] {
        let source = crate::SourceBundle::new(source.into_bytes());
        let scans: usize = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..2)
                .map(|_| {
                    scope.spawn(|| {
                        let mut scans = 0;
                        for _ in 0..4 {
                            let mut decoder = source.decoder().with_strict_reals();
                            for _ in 0..2 {
                                let result = decoder.uniform_context_precision();
                                assert_eq!(result.is_some(), accepted);
                                if let Some(c) = result {
                                    assert_eq!((c.precision, c.root_context), (0.01, 83));
                                }
                            }
                            scans += decoder.uniform_precision_cache.scans;
                        }
                        scans
                    })
                })
                .collect();
            workers
                .into_iter()
                .map(|w| w.join().expect("certificate worker"))
                .sum()
        });
        assert_eq!(
            scans, 1,
            "one whole-source scan across eight fresh job decoders, including cached decline"
        );
    }
}

/// Retain only the real fixture's project/context/unit scaffold, renumbered
/// densely so both compact index implementations exercise this same source.
fn dense_context_source() -> String {
    let mut source = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;".to_string();
    let mut scanner = EntityScanner::new(SOURCE.as_bytes());
    while let Some((id, _, start, end)) = scanner.next_entity() {
        if id < 200 {
            source.push_str(&SOURCE[start..end]);
            source.push(';');
        }
    }
    source.push_str("ENDSEC;END-ISO-10303-21;");
    for (new, old) in [31, 70, 80, 81, 83, 86, 158].into_iter().enumerate().rev() {
        for suffix in [",", ")", "="] {
            source = source.replace(&format!("#{old}{suffix}"), &format!("#{}{suffix}", new + 1));
        }
    }
    source
}

#[test]
fn issue_7714_compact_source_indexes_carry_success_and_decline_across_fresh_decoders() {
    for accepted in [true, false] {
        let source = dense_context_source();
        let source = if accepted {
            source
        } else {
            source.replace("3,0.01,#3", "3,$,#3")
        };
        let columns = Arc::new(
            crate::ColumnarEntityIndex::from_hashmap(&crate::build_entity_index(&source)).unwrap(),
        );
        let bytes = Arc::new(source.into_bytes());
        let delivered = crate::SourceBundle::with_columnar_index(bytes.clone(), columns).unwrap();
        let scanned = crate::SourceBundle::columnar(bytes.clone()).unwrap();
        let dense = crate::SourceBundle::dense_for_certificate_test(bytes);
        for source in [delivered, scanned, dense] {
            let mut scans = 0;
            for _ in 0..8 {
                let mut decoder = source.decoder().with_strict_reals();
                let result = decoder.uniform_context_precision();
                assert_eq!(result.is_some(), accepted);
                if let Some(c) = result {
                    assert_eq!(c.precision, 0.01);
                }
                scans += decoder.uniform_precision_cache.scans;
            }
            assert_eq!(
                scans, 1,
                "compact source cache must retain the result across job decoders"
            );
        }
    }
}

#[test]
fn issue_7714_source_cache_keeps_strict_and_permissive_admission_separate() {
    // An unread malformed root slot is retained by the permissive decoder;
    // geometry admission refuses the entire record. A cached permissive
    // certificate must never make strict certification accept that input.
    let source = SOURCE.replace("3,0.01,#80,$", "3,0.01,#80,1.E400");
    let source = crate::SourceBundle::new(source.into_bytes());
    let mut first = source.decoder();
    assert!(first.uniform_context_precision().is_some());
    let mut first = first.with_strict_reals();
    assert!(first.uniform_context_precision().is_none());
    assert_eq!(first.uniform_precision_cache.scans, 2);
    for strict in [true, false] {
        let mut decoder = source.decoder();
        if strict {
            decoder = decoder.with_strict_reals();
        }
        assert_eq!(decoder.uniform_context_precision().is_some(), !strict);
        assert_eq!(decoder.uniform_precision_cache.scans, 0);
    }
}

#[test]
fn issue_7714_relevant_context_records_must_match_canonical_reference_lookup() {
    // The canonical index resolves the LAST occurrence, including across
    // types. A full-file declaration scan must not certify an earlier root,
    // subcontext or project that is no longer the referenced entity.
    for id in [83, 158, 86] {
        let source = SOURCE.replace(
            "ENDSEC;END-ISO",
            &format!("#{id}=IFCCARTESIANPOINT((0.,0.,0.));ENDSEC;END-ISO"),
        );
        let mut decoder = EntityDecoder::new(&source).with_strict_reals();
        assert_eq!(
            decoder.decode_by_id(id).unwrap().ifc_type,
            IfcType::IfcCartesianPoint
        );
        assert!(
            decoder.uniform_context_precision().is_none(),
            "shadowed declaration #{id}"
        );
    }
}

#[test]
fn issue_7714_certificate_authority_is_bound_to_owned_bytes_not_shared_index() {
    let columns = Arc::new(
        crate::ColumnarEntityIndex::from_hashmap(&crate::build_entity_index(SOURCE)).unwrap(),
    );
    // Same offsets, length, ids and index allocation; different Precision.
    let declined = SOURCE.replace("3,0.01,#80", "3,0.00,#80");
    let accepted = crate::SourceBundle::with_columnar_index(
        Arc::new(SOURCE.as_bytes().to_vec()), columns.clone(),
    ).unwrap();
    let declined = crate::SourceBundle::with_columnar_index(
        Arc::new(declined.into_bytes()), columns,
    ).unwrap();
    for _ in 0..2 {
        assert_eq!(accepted.decoder().uniform_context_precision().unwrap().precision, 0.01);
        assert!(declined.decoder().uniform_context_precision().is_none());
    }
}

#[test]
fn issue_7714_raw_index_replacement_revokes_local_certificate() {
    let source = crate::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    assert!(decoder.uniform_context_precision().is_some());
    // Replacing the index with one missing the root must not reuse either the
    // local answer or the original bundle's successful once cell.
    let mut index = crate::build_entity_index(SOURCE);
    index.remove(&83);
    decoder.set_entity_index(Arc::new(index));
    assert!(!source.owns_decoder(&decoder));
    assert!(decoder.uniform_context_precision().is_none());
    assert!(source.decoder().uniform_context_precision().is_some());
}

#[test]
fn issue_7714_warmed_borrowed_certificate_cannot_acquire_bundle_authority() {
    let source = crate::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = EntityDecoder::new(source.bytes());
    assert!(decoder.uniform_context_precision().is_some());
    assert!(!source.bind_decoder(&mut decoder));
    assert!(!source.owns_decoder(&decoder));
    assert!(source.decoder().uniform_context_precision().is_some());
}
