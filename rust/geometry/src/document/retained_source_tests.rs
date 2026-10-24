// SPDX-License-Identifier: MPL-2.0
//! #7955 wire-contract invariants using genuinely captured IFC source recipes.
use super::*;
use crate::analytic::{extract_analytic_extrusion, with_source_capture};
use crate::document::{GeometryDocument, RetainedExtrusion};
use ifc_lite_core::SourceBundle;
fn request() -> RetainedRequest {
    let source=SourceBundle::new(b"#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,2.,4.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,3.);".to_vec());
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(5).unwrap();
    let source = with_source_capture(|| extract_analytic_extrusion(&entity, &mut decoder));
    let mut doc = GeometryDocument::new();
    let definition = doc
        .add_retained_extrusion(RetainedExtrusion {
            source,
            length_unit_scale: 1.,
        })
        .unwrap();
    doc.prepare_retained(definition, 91)
        .unwrap()
        .with_source_contract(0, 11)
        .unwrap()
}
fn handle(slot: u32) -> Vec<u8> {
    [
        41u64.to_le_bytes().as_slice(),
        slot.to_le_bytes().as_slice(),
        1u32.to_le_bytes().as_slice(),
    ]
    .concat()
}
fn packet() -> Vec<u8> {
    // Numerical packet fixture, not a manufactured runtime/source authority.
    let mut b = Vec::new();
    b.extend(1u32.to_le_bytes());
    b.extend(handle(0));
    b.extend(handle(0));
    for n in [91u64, 0, 11] {
        b.extend(n.to_le_bytes());
    }
    b.extend(5u32.to_le_bytes());
    b.extend(17u64.to_le_bytes());
    b.extend(1u32.to_le_bytes());
    b.extend(6u32.to_le_bytes());
    for i in 0..6u32 {
        b.extend(31u64.to_le_bytes());
        b.extend((i as u64 + 1).to_le_bytes());
        b.extend((if i < 4 { 1u32 } else { i - 2 }).to_le_bytes());
        b.extend((if i < 4 { i } else { 0 }).to_le_bytes());
    }
    b
}
#[test]
fn j5_source_contract_rejects_foreign_epoch_worker_generation_and_partial_inventory() {
    let request = request();
    let original = packet();
    let proof = SourceCorrespondence::decode(&request, &handle(0), &original).unwrap();
    assert_eq!(proof.roles().len(), 6);
    assert!(proof.is_initial_operation(&handle(0), 17));
    assert!(
        !proof.is_initial_operation(&handle(1), 17),
        "foreign source generation/slot cannot bind issuance"
    );
    assert!(
        !proof.is_initial_operation(&handle(0), 18),
        "foreign source operation cannot bind issuance"
    );
    for offset in [
        0, 4, 16, 20, 32, 36, 44, 52, 60, 64, 72, 76, 80, 88, 96, 100,
    ] {
        let mut altered = original.clone();
        altered[offset] ^= 1;
        // Some nonzero source-operation/root ids remain structurally valid;
        // a copy/mesh must still exactly match its original captured inventory.
        let accepted = SourceCorrespondence::decode(&request, &handle(0), &altered);
        assert!(
            accepted.is_err() || !proof.same_source(&accepted.unwrap()),
            "tampered correspondence cannot match original issuance"
        );
    }
    for length in [0, 79, 80, original.len() - 1] {
        assert!(
            SourceCorrespondence::decode(&request, &handle(0), &original[..length]).is_err(),
            "partial inventory refused"
        );
    }
    let mut duplicate = original.clone();
    duplicate[112..120].copy_from_slice(&original[88..96]);
    assert!(
        SourceCorrespondence::decode(&request, &handle(0), &duplicate).is_err(),
        "duplicate physical roots refused"
    );
}
#[test]
fn j5_source_contract_equal_numbers_never_replace_request_allocation() {
    let first = request();
    let second = request();
    let bytes = packet();
    let a = SourceCorrespondence::decode(&first, &handle(0), &bytes).unwrap();
    let b = SourceCorrespondence::decode(&second, &handle(0), &bytes).unwrap();
    assert!(
        !a.same_source(&b),
        "equal numeric identities cannot replace captured source request token"
    );
    let mut copied = bytes.clone();
    copied[4..20].copy_from_slice(&handle(2));
    let copy = SourceCorrespondence::decode(&first, &handle(2), &copied).unwrap();
    assert!(
        a.same_source(&copy),
        "affine output keeps original source inventory"
    );
}
#[test]
fn j5_source_contract_requires_complete_final_triangle_coverage() {
    let request = request();
    let bytes = packet();
    let read = || SourceCorrespondence::decode(&request, &handle(0), &bytes).unwrap();
    assert!(read().with_triangles(vec![0, 1, 2, 3, 4, 5], 6).is_ok());
    for roots in [
        vec![0, 1, 2, 3, 4, 6],
        vec![0, 1, 2, 3, 4, 4],
        vec![0, 1, 2, 3, 4],
    ] {
        assert!(
            read().with_triangles(roots, 6).is_err(),
            "partial or foreign triangle correspondence refused"
        );
    }
}
