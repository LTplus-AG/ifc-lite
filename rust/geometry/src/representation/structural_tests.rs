// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7781 C2-2: shallow entries retain each consumer's admission policy.
use super::*;
use crate::GeometryRouter;

#[test]
fn reference_openings_keep_conservative_malformed_admission() {
    for (shape, reps, expected) in [
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,(#3))",
            "IFCSHAPEREPRESENTATION($,'Reference','Brep',(#999))",
            false,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,(#3))",
            "IFCSHAPEREPRESENTATION($,'Box','BoundingBox',$)",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,(#3))",
            "IFCSHAPEREPRESENTATION($,'Body','Brep',$)",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,(#3))",
            "IFCTOPOLOGYREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,(#3,$))",
            "IFCSHAPEREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,(#3,#999))",
            "IFCSHAPEREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,())",
            "IFCSHAPEREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$,$)",
            "IFCSHAPEREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
        (
            "IFCPRODUCTDEFINITIONSHAPE($,$)",
            "IFCSHAPEREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
        (
            "IFCSHAPEREPRESENTATION($,$,(#3))",
            "IFCSHAPEREPRESENTATION($,'Reference','Reference',())",
            true,
        ),
    ] {
        let source = format!("#1=IFCOPENINGELEMENT('g',$,$,$,$,$,#2,$);#2={shape};#3={reps};");
        let mut decoder = EntityDecoder::new(&source);
        assert_eq!(
            GeometryRouter::new().opening_requires_subtraction(1, &mut decoder),
            expected,
            "{source}"
        );
    }
    for element in [
        "IFCWALL('g',$,$,$,$,$,#2,$)",
        "IFCOPENINGELEMENT('g')",
        "IFCOPENINGELEMENT('g',$,$,$,$,$,$,$)",
    ] {
        let source = format!("#1={element};");
        assert!(GeometryRouter::new().opening_requires_subtraction(1, &mut EntityDecoder::new(&source)));
    }
}

#[test]
fn reference_openings_bound_before_predecode_and_never_read_geometry() {
    for count in [64, 65] {
        let refs = vec!["#3"; count].join(",");
        let source = format!(
            "#1=IFCOPENINGELEMENT('g',$,$,$,$,$,#2,$);\
            #2=IFCPRODUCTDEFINITIONSHAPE($,$,({refs}));\
            #3=IFCSHAPEREPRESENTATION($,'Reference','Brep',(#4));#4=IFCCARTESIANPOINT((1.,2.,3.));"
        );
        let mut decoder = EntityDecoder::new(&source);
        assert_eq!(
            GeometryRouter::new().opening_requires_subtraction(1, &mut decoder),
            count > 64
        );
        assert_eq!(decoder.cache_size(), if count == 64 { 3 } else { 2 });
    }
    let source = "#1=IFCOPENINGELEMENT('g',$,$,$,$,$,#2,$);\
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3,#4));\
        #3=IFCSHAPEREPRESENTATION($,'Box','BoundingBox',$);\
        #4=IFCSHAPEREPRESENTATION($,'Reference','Brep',(#999));";
    assert!(!GeometryRouter::new().opening_requires_subtraction(1, &mut EntityDecoder::new(source)));
}

#[test]
fn routing_identity_does_not_admit_or_decode_a_shape_before_hashing() {
    let source = "#1=IFCWALL('g',$,$,$,$,$,#2,$);#2=IFCCARTESIANPOINT((1.,2.,3.));";
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(1).unwrap();
    assert_eq!(product_shape_id(&element), Some(2));
    assert_eq!(decoder.cache_size(), 1, "identity alone performs no decode");
    let router = GeometryRouter::new();
    let key = router.geometry_routing_key(&element, &mut decoder).unwrap();
    // A warm signature memo needs only the ID, even when no shape can decode.
    let mut cold = EntityDecoder::new("#1=IFCWALL('g',$,$,$,$,$,#2,$);");
    assert_eq!(router.geometry_routing_key(&element, &mut cold), Some(key));
    assert_eq!(cold.cache_size(), 0, "routing must not eagerly resolve the shape");
    for value in ["$", "()", "42", "'bad'"] {
        let source = format!("#1=IFCWALL('g',$,$,$,$,$,{value},$);");
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1).unwrap();
        assert_eq!(router.geometry_routing_key(&element, &mut decoder), None);
    }
}

// #7782 C4-8a: these are shallow reads, not strict representation admission.
#[test]
fn shallow_ids_preserve_dangling_and_non_list_policies() {
    let source = "#1=IFCWALL('g',$,$,$,$,$,#999,$);\
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#999,$,#998));\
        #3=IFCSHAPEREPRESENTATION($,$,$,#999);\
        #4=IFCSHAPEREPRESENTATION($,$,$,(#999,$,#998));\
        #5=IFCPRODUCTDEFINITIONSHAPE($,$,#999);";
    let mut decoder = EntityDecoder::new(source);
    assert_eq!(product_shape_id(&decoder.decode_by_id(1).unwrap()), Some(999));
    assert_eq!(
        pds_representation_ids(&decoder.decode_by_id(2).unwrap()).collect::<Vec<_>>(),
        vec![999, 998]
    );
    assert_eq!(rep_item_ids(&decoder.decode_by_id(3).unwrap()).count(), 0);
    assert_eq!(
        rep_item_ids(&decoder.decode_by_id(4).unwrap()).collect::<Vec<_>>(),
        vec![999, 998]
    );
    assert_eq!(
        pds_representation_ids(&decoder.decode_by_id(5).unwrap()).collect::<Vec<_>>(),
        vec![999]
    );
    assert_eq!(decoder.cache_size(), 5, "ID reads never decode list members");
}

// #7782: legacy probes do not require MappingSource to be a representation map.
#[test]
fn shallow_mapped_hop_preserves_wrong_type_source_leniency() {
    let source = "#1=IFCMAPPEDITEM(#2,$);#2=IFCWALL($,#999);\
        #3=IFCMAPPEDITEM(#998,$);#4=IFCMAPPEDITEM(#5,$);#5=IFCWALL($,42);";
    let mut decoder = EntityDecoder::new(source);
    let item = decoder.decode_by_id(1).unwrap();
    assert_eq!(mapped_item_representation_id(&item, &mut decoder), Some(999));
    assert_eq!(decoder.cache_size(), 2, "only the source is decoded");
    for id in [3, 4] {
        let item = decoder.decode_by_id(id).unwrap();
        assert_eq!(mapped_item_representation_id(&item, &mut decoder), None);
    }
}
