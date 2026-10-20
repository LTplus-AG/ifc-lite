// SPDX-License-Identifier: MPL-2.0
//! Source/index ownership invariants for the model-context migration.
use super::*;
use crate::{build_entity_index, ColumnarEntityIndex};

#[test]
fn same_sized_sources_and_identical_ids_do_not_authenticate_mismatched_spans() {
    let a = b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.)); #2=IFCDIRECTION((0.,0.,1.));";
    let b = b"DATA; #1=IFCCARTESIANPOINT((1.,2.,3.));#2=IFCDIRECTION((0.,0.,1.));";
    assert_eq!(a.len(), b.len());
    let index = Arc::new(ColumnarEntityIndex::from_scan(a).unwrap());
    assert!(SourceBundle::with_columnar_index(Arc::new(b.to_vec()), index).is_err());
    let canonical = Arc::new(ColumnarEntityIndex::from_scan(b).unwrap());
    let source = SourceBundle::with_columnar_index(Arc::new(b.to_vec()), canonical).unwrap();
    assert_eq!(source.decoder().decode_by_id(1).unwrap().id, 1);
}

#[test]
fn missing_extra_and_duplicate_rows_obey_the_canonical_scanner_not_length_checks() {
    let bytes = Arc::new(b"DATA;#2=IFCWALL('old');#1=IFCWALL();#2=IFCBEAM('last');".to_vec());
    let index = Arc::new(ColumnarEntityIndex::from_scan(bytes.as_slice()).unwrap());
    let source = SourceBundle::with_columnar_index(bytes.clone(), index).unwrap();
    assert_eq!(
        source.decoder().decode_by_id(2).unwrap().ifc_type,
        crate::IfcType::IfcBeam
    );
    let partial = Arc::new(
        ColumnarEntityIndex::from_hashmap_consuming(
            [(1, build_entity_index(bytes.as_slice())[&1])]
                .into_iter()
                .collect(),
        )
        .unwrap(),
    );
    assert!(SourceBundle::with_columnar_index(bytes.clone(), partial).is_err());
    let mut extra = build_entity_index(bytes.as_slice());
    extra.insert(99, (0, 4));
    let extra = Arc::new(ColumnarEntityIndex::from_hashmap_consuming(extra).unwrap());
    assert!(SourceBundle::with_columnar_index(bytes, extra).is_err());
}

#[test]
fn original_non_utf8_bytes_survive_caller_drop_and_fresh_decoders_share_the_bundle() {
    let bytes = Arc::new(b"DATA;#1=IFCWALL('\xff');".to_vec());
    let weak = Arc::downgrade(&bytes);
    let source = SourceBundle::scan_with(bytes, |_, _, _, _| {});
    let mut first = source.decoder();
    let mut second = source.decoder();
    assert_eq!(first.get_raw_bytes(1).unwrap(), b"#1=IFCWALL('\xff');");
    assert_eq!(second.decode_by_id(1).unwrap().id, 1);
    assert!(source.owns_decoder(&first));
    assert!(source.owns_decoder(&second));
    assert_eq!(
        weak.strong_count(),
        1,
        "decoders retain the bundle, never clone source bytes"
    );
    first.set_entity_index(Arc::new(build_entity_index(source.bytes())));
    assert!(
        !source.owns_decoder(&first),
        "legacy setter cannot retain factory authority"
    );
    assert!(source.owns_decoder(&second));
}

#[test]
fn arbitrary_decoder_cannot_keep_a_prebuilt_index_when_adopting_factory_source() {
    let source = SourceBundle::new(b"DATA;#1=IFCWALL();".to_vec());
    let mut decoder = EntityDecoder::with_index(source.bytes(), Default::default());
    assert!(!source.bind_decoder(&mut decoder));
    let mut decoder = EntityDecoder::new(source.bytes());
    assert!(source.bind_decoder(&mut decoder));
    assert_eq!(decoder.decode_by_id(1).unwrap().id, 1);
}

#[test]
fn validated_span_reuse_does_not_import_another_sources_lazy_inverse_caches() {
    // Equal span tables are valid for both sources, but their relationships
    // differ. A table's previously populated caches are not source authority.
    let a=b"DATA;#1=IFCSTYLEDITEM(#2,(),$);#2=IFCWALL();#3=IFCBEAM();#4=IFCGRIDAXIS('A',$,.T.);#5=IFCGRIDAXIS('B',$,.T.);#9=IFCGRID('g',$,$,$,$,$,$,(#4),(),$);";
    let b = String::from_utf8(a.to_vec())
        .unwrap()
        .replace("IFCSTYLEDITEM(#2", "IFCSTYLEDITEM(#3")
        .replace("(#4),()", "(#5),()")
        .into_bytes();
    let index = Arc::new(ColumnarEntityIndex::from_scan(a).unwrap());
    let mut old = EntityDecoder::with_arc_columnar_index(a, index.clone());
    assert_eq!(old.styled_item_ids(2).unwrap(), [1]);
    assert_eq!(old.grid_of_axis(4), Some(9));
    let source = SourceBundle::with_columnar_index(Arc::new(b), index).unwrap();
    let mut expected = EntityDecoder::new(source.bytes());
    assert_eq!(expected.styled_item_ids(3).unwrap(), [1]);
    assert_eq!(expected.grid_of_axis(5), Some(9));
    for _ in 0..2 {
        let mut actual = source.decoder();
        assert!(actual.styled_item_ids(2).unwrap().is_empty());
        assert_eq!(actual.styled_item_ids(3).unwrap(), [1]);
        assert_eq!(actual.grid_of_axis(4), None);
        assert_eq!(actual.grid_of_axis(5), Some(9));
    }
    assert!(
        source.styled_items.get().is_some(),
        "the actual source cache is reused by fresh decoders"
    );
}
