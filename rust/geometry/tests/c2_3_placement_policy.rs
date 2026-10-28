// SPDX-License-Identifier: MPL-2.0
//! #7781 C2-3: sharing scaled placement must preserve public error policy.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{Error, GeometryRouter};

fn placement(slot: &str, strict: bool, refused: bool) -> (Result<[f64; 16], Error>, u64) {
    let content = format!(
        "#1=IFCCARTESIANPOINT((1000.,2000.,3000.));\n\
         #2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #3=IFCLOCALPLACEMENT($,#2);\n\
         #4=IFCLOCALPLACEMENT($,$);\n\
         #10=IFCWALL('w',$,$,$,$,{slot},$,$,$);"
    );
    let mut decoder = EntityDecoder::new(&content);
    let element = decoder.decode_by_id(10).unwrap();
    let mut router = GeometryRouter::with_scale(0.001);
    if refused {
        router.refuse_length_unit();
    }
    let result = if strict {
        router.resolve_scaled_placement_strict(&element, &mut decoder)
    } else {
        router.resolve_scaled_placement(&element, &mut decoder)
    };
    (result, decoder.refused_records())
}

#[test]
fn issue_7781_scaled_placement_preserves_column_major_units_and_absence() {
    for strict in [false, true] {
        let (result, refused) = placement("#3", strict, false);
        assert_eq!(
            result.unwrap(),
            [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 1., 2., 3., 1.]
        );
        assert_eq!(refused, 0);
        assert_eq!(
            placement("$", strict, false).0.unwrap(),
            [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.]
        );
    }
}

#[test]
fn issue_7781_strict_precheck_keeps_its_error_and_precedes_counted_resolution() {
    let (strict, refused) = placement("42", true, false);
    assert!(matches!(strict, Err(Error::GeometryError(ref message))
        if message == "ObjectPlacement for #10 cannot be resolved"));
    assert_eq!(
        refused, 0,
        "strict precheck does not enter the counted resolver"
    );
    let (lax, refused) = placement("42", false, false);
    assert!(matches!(
        lax,
        Err(Error::CoreError(ifc_lite_core::Error::MalformedRecord(10)))
    ));
    assert_eq!(refused, 1);
    for strict in [false, true] {
        let (result, _) = placement("#4", strict, false);
        assert!(matches!(result, Err(Error::GeometryError(ref message))
            if message == "#4: missing RelativePlacement"));
        assert!(matches!(
            placement("#999", strict, false).0,
            Err(Error::CoreError(_))
        ));
    }
}

#[test]
fn issue_7781_length_admission_precedes_strict_precheck_and_lax_decode() {
    for strict in [false, true] {
        for slot in ["42", "#999", "#4", "#3", "$"] {
            let (result, refused) = placement(slot, strict, true);
            assert!(matches!(result, Err(Error::GeometryError(ref message))
                if message == "length unit refused (#7678): no scaled placement"));
            assert_eq!(
                refused, 0,
                "placement must not be decoded after unit refusal"
            );
        }
    }
}
