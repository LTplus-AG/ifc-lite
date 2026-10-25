// SPDX-License-Identifier: MPL-2.0

use super::{assert_partition, census_bytes, model};

fn assert_unverified_prefix(input: &str) {
    let fixture = census_bytes(input.as_bytes());
    assert!(!fixture.enumeration_complete, "{:?}", fixture.diagnostics);
    assert_eq!(fixture.status, "source_enumeration_failed");
    assert!(fixture
        .diagnostics
        .iter()
        .any(|d| d == "enumeration:unverified_DATA_prefix"));
    assert_eq!(fixture.counts.source_only_candidates, 0);
    assert_eq!(fixture.counts.no_representation_products, 0);
    assert_eq!(fixture.counts.source_admitted_products, 0);
    assert_eq!(
        fixture.counts.source_uninspected_products,
        fixture.products.len()
    );
    for product in fixture.products.values() {
        assert_eq!(product.source_admission, "uninspected");
        assert_eq!(product.verdict, "refused");
        assert!(!product.enumeration_complete);
    }
    assert_partition(&fixture);
}

#[test]
fn issue_7955_pre_data_storey_cannot_certify_complete_inventory() {
    // Exact M1 review counterexample: the original suffix is valid, and #23
    // is outside DATA. Refuse completeness rather than silently losing it.
    let input = model("").replace(
        "ENDSEC;\nDATA;",
        "ENDSEC;\n#23=IFCBUILDINGSTOREY('0000000000000000000023',$,$,$,$,#7,#12,$,.ELEMENT.,0.);\nDATA;",
    );
    assert_unverified_prefix(&input);
    let fixture = census_bytes(input.as_bytes());
    assert!(fixture.products.contains_key(&13));
    assert!(!fixture
        .diagnostics
        .iter()
        .any(|d| d == "enumeration:unverified_DATA_end"));
}

#[test]
fn issue_7955_missing_or_misplaced_prefix_markers_are_incomplete() {
    let original = model("");
    for input in [
        original.replacen("ISO-10303-21;", "", 1),
        original.replacen("ISO-10303-21;", "ISO-10303-21", 1),
        original.replace("HEADER;", ""),
        original.replace("HEADER;", "HEADER"),
        original.replace("HEADER;", "DATA;\nHEADER;"),
        original.replace("ENDSEC;\nDATA;", "DATA;"),
        original.replace("ENDSEC;\nDATA;", "ENDSEC\nDATA;"),
        original.replace("ENDSEC;\nDATA;", "ENDSEC;\nENDSEC;\nDATA;"),
        original.replace("DATA;", ""),
        original.replace("DATA;", "DATA"),
        original.replace("DATA;", "METADATA;\nDATA;"),
        original.replace("DATA;", "DATA('model',('IFC4'))\nDATA;"),
        original.replace("DATA;", "DATA('model',(#23=IFCWALL($)));"),
        original.replace("FILE_SCHEMA(('IFC4'));", "FILE_SCHEMA(('IFC4'))"),
        original.replace("FILE_SCHEMA(('IFC4'));", "FILE_SCHEMA(('IFC4');)"),
        original.replace("HEADER;", "HEADER;\n#23=IFCWALL($);"),
        original.replace("HEADER;", "HEADER;\nUNSUPPORTED_EXTENSION('value');"),
        original.replace("FILE_DESCRIPTION(('')", "FILE_DESCRIPTION((#23=IFCWALL($))"),
        format!("#23=IFCWALL($);\n{original}"),
        original.replace("ENDSEC;\nDATA;", "ENDSEC;\n'prefix text'\nDATA;"),
        original.replace("ENDSEC;\nDATA;", "ENDSEC;\nANCHOR;\nENDSEC;\nDATA;"),
    ] {
        assert_unverified_prefix(&input);
    }
}

#[test]
fn issue_7955_quoted_commented_and_parameterized_headers_remain_complete() {
    let quoted = model("").replace(
        "FILE_DESCRIPTION(('')",
        "FILE_DESCRIPTION(('DATA; ENDSEC; #23=IFCWALL($); ''quoted'' (text)')",
    );
    // The shared literal reader treats a page-directive apostrophe as an
    // operand, not a close quote. Structural decoys remain inside the string.
    let page_quoted = model("").replace(
        "FILE_DESCRIPTION(('')",
        r"FILE_DESCRIPTION(('\S\' DATA; ENDSEC; #23=IFCWALL($);')",
    );
    let commented = quoted
        .replace("HEADER;", "HEADER /* DATA; #23=IFCWALL($); */ ;")
        .replace("FILE_SCHEMA((", "FILE_SCHEMA /* ENDSEC; */ ((")
        .replace(
            "ENDSEC;\nDATA;",
            "ENDSEC /* #23=IFCWALL($); */ ;\n/* DATA; */ DATA /* transition */ ;",
        );
    let parameterized = commented.replace(
        "DATA /* transition */ ;",
        "data /* transition */ ('DATA; #23=IFCWALL($);', /* ) ; */ ('IFC4')) /* end */ ;",
    );
    for input in [
        quoted,
        page_quoted,
        commented,
        parameterized,
        format!("\u{feff}{}", model("")),
        format!(" /* DATA; #23=IFCWALL($); */\n{}", model("")),
    ] {
        let fixture = census_bytes(input.as_bytes());
        assert!(fixture.enumeration_complete, "{:?}", fixture.diagnostics);
        assert_eq!(fixture.status, "present");
        assert_eq!(fixture.products.keys().copied().collect::<Vec<_>>(), [13]);
        assert_eq!(fixture.products[&13].source_admission, "admitted");
        assert_eq!(fixture.products[&13].verdict, "source_only_candidate");
        assert_partition(&fixture);
    }
}

#[test]
fn issue_7955_empty_data_still_requires_verified_prefix() {
    let original = model("");
    let (prefix, _) = original.split_once("DATA;\n").unwrap();
    let empty = format!("{prefix}DATA;\nENDSEC;\nEND-ISO-10303-21;\n");
    let fixture = census_bytes(empty.as_bytes());
    assert!(fixture.enumeration_complete, "{:?}", fixture.diagnostics);
    assert!(fixture.products.is_empty());
    assert_partition(&fixture);
    assert_unverified_prefix(&empty.replace("DATA;", "#23=IFCWALL($);\nDATA;"));
    assert_unverified_prefix(&empty.replace("ENDSEC;\nDATA;", "DATA;"));
}

#[test]
fn issue_7955_prefix_bound_and_suffix_checks_remain_independent() {
    let padded = model("").replace(
        "HEADER;",
        &format!(
            "HEADER;/* {} */",
            "x".repeat(ifc_lite_core::parser::header::MAX_HEADER_BYTES)
        ),
    );
    assert_unverified_prefix(&padded);
    let input = model("").replace("END-ISO-10303-21;", "");
    let fixture = census_bytes(input.as_bytes());
    assert!(!fixture.enumeration_complete);
    assert!(fixture
        .diagnostics
        .iter()
        .any(|d| d == "enumeration:unverified_DATA_end"));
    assert!(!fixture
        .diagnostics
        .iter()
        .any(|d| d == "enumeration:unverified_DATA_prefix"));
    assert_eq!(fixture.products[&13].source_admission, "uninspected");
    assert_partition(&fixture);
}
