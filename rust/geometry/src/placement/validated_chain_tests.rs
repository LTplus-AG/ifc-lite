// SPDX-License-Identifier: MPL-2.0
//! #7779 E1: strict validation and actual canonical-climb work invariants.
use super::chain_walk::VALIDATION_WORK;
use super::*;
use ifc_lite_core::{EntityDecoder, Error};

fn ladder(n: u32) -> String {
    let mut source = String::from("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;\n#1=IFCCARTESIANPOINT((1.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\n");
    for id in 10..10 + n {
        let parent = if id == 10 {
            "$".into()
        } else {
            format!("#{}", id - 1)
        };
        source.push_str(&format!("#{id}=IFCLOCALPLACEMENT({parent},#2);\n"));
    }
    source.push_str("ENDSEC;END-ISO-10303-21;");
    source
}

#[test]
fn issue_7779_verified_suffix_reuse_visits_each_new_ladder_link_once() {
    for n in [80, 320, 2000] {
        let source = ladder(n);
        let mut decoder = EntityDecoder::new(&source);
        VALIDATION_WORK.with(|count| count.set(0));
        let mut validator = ChainValidator::new(&mut decoder, ChainPolicy::default());
        for id in 10..10 + n {
            let (root, links) = validator.validate(id).unwrap();
            assert_eq!(root, 10);
            assert_eq!(links.iter().map(|link| link.id).collect::<Vec<_>>(), [id]);
        }
        assert_eq!(
            VALIDATION_WORK.with(|count| count.get()),
            n as usize,
            "actual climb visits; full-prefix traversal would cost n*(n+1)/2"
        );
        assert!(validator.validate(9 + n).unwrap().1.is_empty());
        assert_eq!(VALIDATION_WORK.with(|count| count.get()), n as usize);
    }
}

#[test]
fn issue_7779_verified_session_is_policy_local_and_failures_are_never_cached() {
    let source = ladder(320).replace(
        "#1=IFCCARTESIANPOINT((1.,0.,0.))",
        "#1=IFCCARTESIANPOINT((1.,0.))",
    );
    let mut decoder = EntityDecoder::new(&source);
    let mut lenient = ChainValidator::new(&mut decoder, ChainPolicy::default());
    assert_eq!(lenient.validate(329).unwrap().0, 10);
    drop(lenient);
    let mut strict = ChainValidator::new(
        &mut decoder,
        ChainPolicy {
            strict_spatial: true,
            ..ChainPolicy::default()
        },
    );
    for _ in 0..2 {
        assert!(matches!(
            strict.validate(329),
            Err(PlacementError::Policy { .. })
        ));
    }
    drop(strict);
    // A new session cannot reuse same numeric ids from a different source.
    let cyclic = ladder(320).replace(
        "#10=IFCLOCALPLACEMENT($,#2)",
        "#10=IFCLOCALPLACEMENT(#329,#2)",
    );
    let mut decoder = EntityDecoder::new(&cyclic);
    let mut validator = ChainValidator::new(&mut decoder, ChainPolicy::default());
    for _ in 0..2 {
        assert!(matches!(
            validator.validate(329),
            Err(PlacementError::Cyclic { .. })
        ));
    }
    assert_eq!(validator.decoder().refused_records(), 1);
}

#[test]
fn issue_7779_strict_policy_preserves_canonical_typed_refusal_and_default_axis_wr() {
    for (replacement, counted) in [
        ("#1=IFCDIRECTION((1.,0.,0.))", true),
        ("#1=IFCCARTESIANPOINT((IFCLENGTHMEASURE(1.),0.,0.))", true),
        ("#1=IFCCARTESIANPOINT((1.,0.,0.));#3=IFCDIRECTION((1.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,#3,$)", false),
    ] {
        let template = if counted { ladder(2) } else { ladder(2).replace("#2=IFCAXIS2PLACEMENT3D(#1,$,$);", "") };
        let source = template.replace("#1=IFCCARTESIANPOINT((1.,0.,0.))", replacement);
        let mut decoder = EntityDecoder::new(&source);
        let leaf = decoder.decode_by_id(11).unwrap();
        let strict = ChainPolicy { strict_spatial: true, ..ChainPolicy::default() };
        let error = validate_chain(&leaf, &mut decoder, &strict).unwrap_err();
        if counted {
            assert!(matches!(error, PlacementError::Decode(Error::MalformedRecord(1))), "{error:?}");
            assert_eq!(decoder.refused_records(), 1);
            let frame = decoder.decode_by_id(2).unwrap();
            assert!(Axis2Placement::read_3d(&frame, &mut decoder).is_err());
            assert_eq!(decoder.refused_records(), 1, "canonical refusal counted once");
        } else {
            assert!(matches!(error, PlacementError::Policy { .. }));
            assert_eq!(decoder.refused_records(), 0, "strict WR is a consumer policy");
            validate_chain(&leaf, &mut decoder, &ChainPolicy::default()).unwrap();
        }
    }
}

#[test]
fn issue_7779_linear_source_admission_uses_declared_positions_and_counted_typed_leaves() {
    let policy = ChainPolicy {
        linear: true,
        ..ChainPolicy::default()
    };
    for (schema, linear) in [
        ("IFC4X1", "IFCLINEARPLACEMENT($,$,$,#23)"),
        ("IFC4X2", "IFCLINEARPLACEMENT($,$,$,$,#23)"),
        ("IFC4X3_ADD2", "IFCLINEARPLACEMENT($,$,#23)"),
        ("IFC4", "IFCLINEARPLACEMENT($,$,#23)"),
        ("IFC2X3", "IFCLINEARPLACEMENT($,$,#23)"),
    ] {
        let source = format!("ISO-10303-21;HEADER;FILE_SCHEMA(('{schema}'));ENDSEC;DATA;\n#21=IFCCARTESIANPOINT((4.,5.,6.));#23=IFCAXIS2PLACEMENT3D(#21,$,$);#70={linear};ENDSEC;END-ISO-10303-21;");
        let mut decoder = EntityDecoder::new(&source);
        let placement = decoder.decode_by_id(70).unwrap();
        validate_chain(&placement, &mut decoder, &policy).unwrap();
        assert_eq!(decoder.refused_records(), 0);
        for malformed in [
            source.replace(",#23)", ",$)"),
            source.replace("IFCCARTESIANPOINT((4.,5.,6.))", "IFCDIRECTION((4.,5.,6.))"),
        ] {
            let mut decoder = EntityDecoder::new(&malformed);
            let placement = decoder.decode_by_id(70).unwrap();
            assert!(
                validate_chain(&placement, &mut decoder, &policy).is_err(),
                "{schema}: {malformed}"
            );
            assert_eq!(
                decoder.refused_records(),
                1,
                "canonical source refusal: {schema}"
            );
        }
    }
    let source = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X2'));ENDSEC;DATA;#21=IFCCARTESIANPOINT((4.,5.,6.));#23=IFCAXIS2PLACEMENT3D(#21,$,$);#70=IFCLINEARPLACEMENT($,$,#23,$,$);ENDSEC;END-ISO-10303-21;";
    let mut decoder = EntityDecoder::new(source);
    let placement = decoder.decode_by_id(70).unwrap();
    assert!(
        matches!(
            validate_chain(&placement, &mut decoder, &policy),
            Err(PlacementError::Missing { .. })
        ),
        "Distance slot is not CartesianPosition"
    );
    assert_eq!(decoder.refused_records(), 1);
}

#[test]
fn issue_7779_verified_suffixes_do_not_survive_decoder_replacement() {
    let valid = ladder(3);
    let cyclic = valid.replace(
        "#10=IFCLOCALPLACEMENT($,#2)",
        "#10=IFCLOCALPLACEMENT(#12,#2)",
    );
    let mut decoder = EntityDecoder::new(&valid);
    let mut validator = ChainValidator::new(&mut decoder, ChainPolicy::default());
    assert_eq!(validator.validate(12).unwrap().0, 10);
    assert!(
        validator.validate(12).unwrap().1.is_empty(),
        "unchanged source reuses the suffix"
    );
    // Mutable decoder access permits replacing its owner, even while the
    // validator's policy stays fixed. The same ids now describe a cycle.
    *validator.decoder() = EntityDecoder::new(&cyclic);
    for _ in 0..2 {
        assert!(matches!(
            validator.validate(12),
            Err(PlacementError::Cyclic { .. })
        ));
    }
    assert_eq!(validator.decoder().refused_records(), 1);
}
