// SPDX-License-Identifier: MPL-2.0
//! Round-2 preservation regression: malformed duplicate IDs retain the native
//! scan decoder's historical first-success cache through the shared prepass.
use super::*;
use crate::prepass::{resolve_prepass, ResolveOptions};
use super::super::entity_index::ProcessingIndex;
use ifc_lite_core::{Error, SourceBundle};
use std::sync::Arc;

fn scan_and_resolve(bytes: &[u8], cross_class: bool) {
    let bytes = Arc::new(bytes.to_vec());
    let req = ProcessingRequest::default();
    assert!(req.features.presentation_layers);
    let mut decoder = EntityDecoder::new(bytes.as_slice()).with_strict_reals();
    let mut scanner = EntityScanner::new(bytes.as_slice());
    let mut last = None;
    while let Some(record) = scanner.next_entity() { last = Some(record); }
    let (_, _, start, end) = last.unwrap();
    assert!(matches!(decoder.decode_at(start, end), Err(Error::UnrepresentableReal(101))));
    let (scan, source) = scan_entities(bytes.as_slice(), &req, &mut decoder, Some(bytes.clone()));
    assert_eq!(scan.presentation_layer_by_assigned_id.get(&10).map(String::as_str), Some("first"));
    assert!(!scan.presentation_layer_by_assigned_id.contains_key(&20));
    let source = source.unwrap();
    ProcessingIndex::Owned(source.clone()).install(&mut decoder);
    assert!(!source.owns_decoder(&decoder));
    assert!(!source.bind_decoder(&mut decoder));
    assert!(decoder.strict_reals());
    assert_eq!(decoder.refused_records(), 1);
    let cached = decoder.decode_by_id(100).unwrap();
    assert_eq!(cached.ifc_type, IfcType::IfcPresentationLayerAssignment);
    assert_eq!(cached.get_string(0), Some("first"));
    let resolved = resolve_prepass(&scan.prepass_spans, &mut decoder, ResolveOptions::default());
    assert!(resolved.void_index.is_empty(), "cross-class duplicate must reuse the scan cache");
    assert_eq!(decoder.decode_by_id(100).unwrap().get_string(0), Some("first"));
    assert_eq!(decoder.refused_records(), 1);
    // Workers historically start independently: canonical last occurrence wins.
    let mut worker = source.decoder();
    assert!(source.owns_decoder(&worker));
    let last = worker.decode_by_id(100).unwrap();
    if cross_class {
        assert_eq!(last.ifc_type, IfcType::IfcRelVoidsElement);
        let fresh = resolve_prepass(&scan.prepass_spans, &mut worker, ResolveOptions::default());
        assert_eq!(fresh.void_index.get(&10), Some(&vec![20]));
    } else {
        assert_eq!(last.get_string(0), Some("second"));
    }
}

#[test]
fn duplicate_layer_keeps_first_attribution_and_shared_prepass_lookup() {
    scan_and_resolve(b"DATA;#100=IFCPRESENTATIONLAYERASSIGNMENT('first',$,(#10),$);\
        #100=IFCPRESENTATIONLAYERASSIGNMENT('second',$,(#20),$);\
        #101=IFCCARTESIANPOINT((1.E400,0.,0.));", false);
}

#[test]
fn cross_class_duplicate_keeps_scan_cache_during_shared_void_resolution() {
    scan_and_resolve(b"DATA;#100=IFCPRESENTATIONLAYERASSIGNMENT('first',$,(#10),$);\
        #100=IFCRELVOIDSELEMENT('rel',$,$,$,#10,#20);\
        #101=IFCCARTESIANPOINT((1.E400,0.,0.));", true);
}

#[test]
fn compatibility_install_revokes_existing_factory_authority() {
    let source = SourceBundle::new(b"DATA;#1=IFCWALL();".to_vec());
    let mut decoder = source.decoder();
    decoder.decode_by_id(1).unwrap();
    source.install_compatibility_index(&mut decoder);
    assert!(!source.owns_decoder(&decoder));
    assert_eq!(decoder.cache_size(), 1);
}
