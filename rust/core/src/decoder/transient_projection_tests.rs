// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{EntityDecoder, EntityIndex};
use std::sync::Arc;

fn indexed(source: &[u8]) -> EntityDecoder<'_> {
    let mut index = EntityIndex::default();
    index.insert(1, (0, source.len()));
    EntityDecoder::with_index(source, index)
}

// #3987: projection retains Name's exact string contract, including IFC
// escaping and non-string/absent fields. Other fields are still fully parsed.
#[test]
fn transient_string_projection_preserves_name_semantics_3987() {
    for (name, expected) in [
        ("'ePSet_MapConversion'", Some("ePSet_MapConversion")),
        ("''", Some("")),
        ("'O''Brien'", Some("O'Brien")),
        (r"'ePSet_\X2\004D00610070\X0\Conversion'", Some("ePSet_MapConversion")),
        ("$", None),
        ("*", None),
        ("42", None),
        (".TRUE.", None),
        ("IFCLABEL('ePSet_MapConversion')", None),
        ("('ePSet_MapConversion')", None),
    ] {
        let source = format!("#1=IFCPROPERTYSET('g',$,{name},'unused',(#2,#3,#2));");
        let mut decoder = indexed(source.as_bytes());
        let actual = decoder.decode_string_by_id_transient(1, 2).unwrap();
        assert_eq!(actual.as_deref(), expected, "{name}");
        let original = decoder.decode_at_uncached(0, source.len()).unwrap();
        assert_eq!(actual.as_deref(), original.get_string(2));
        assert_eq!(decoder.cache_size(), 0, "transient reads retain no entity");
    }
    let mut empty = indexed(b"#1=IFCPROPERTYSET();");
    assert_eq!(empty.decode_string_by_id_transient(1, 2).unwrap(), None);
    let source = b"#1=IFCPROPERTYSET('g',$,'invalid \xff',$,());";
    let mut decoder = indexed(source);
    assert_eq!(decoder.decode_string_by_id_transient(1, 2).unwrap().as_deref(), Some("invalid \u{fffd}"));
}

// #3987: a readable Name does not excuse invalid unused fields, even if those
// fields would never be converted into AttributeValue by the projection.
#[test]
fn transient_string_projection_validates_unused_tail_3987() {
    for source in [
        "#1=IFCPROPERTYSET('g',$,'readable',$,(#4294967296));",
        "#1=IFCPROPERTYSET('g',$,'readable',$,(@));",
        "#1=IFCPROPERTYSET('g',$,'readable',$,('unterminated));",
        "#1=IFCPROPERTYSET('g',$,'readable',$,(1e999999));",
        "#1=IFCPROPERTYSET('g',$,'readable',$,(#2));/*",
    ] {
        let mut decoder = indexed(source.as_bytes());
        let original = decoder.decode_at_uncached(0, source.len());
        let projected = decoder.decode_string_by_id_transient(1, 2);
        // parse_entity historically accepts bytes after the terminating ';'.
        // Preserve that too: do not add a stricter full-slice grammar here.
        match original {
            Ok(entity) => assert_eq!(projected.unwrap().as_deref(), entity.get_string(2)),
            Err(error) => assert_eq!(projected.unwrap_err().to_string(), error.to_string()),
        }
        assert_eq!(decoder.cache_size(), 0);
    }
    let source = b"#1=IFCPROPERTYSET('g',$,'readable',$,(@));";
    assert!(indexed(source).decode_string_by_id_transient(1, 2).is_err());
}

// #3987: a supplied index can map a requested id onto another declared id.
// Requested cache hits bypass parsing; parsed-id hits happen AFTER validation.
#[test]
fn transient_string_projection_preserves_alias_cache_precedence_3987() {
    let records = [
        "#1=IFCPROPERTYSET('g',$,'requested cache',$,());",
        "#2=IFCPROPERTYSET('g',$,'parsed cache',$,());",
        "#2=IFCPROPERTYSET('g',$,'uncached alias',$,());",
        "#2=IFCPROPERTYSET('g',$,'malformed alias',$,(@));",
    ];
    let mut source = String::new();
    let mut spans = Vec::new();
    for record in records {
        let start = source.len();
        source.push_str(record);
        spans.push((start, source.len()));
    }
    let mut decoder = EntityDecoder::new(&source);
    decoder.decode_at(spans[0].0, spans[0].1).unwrap();
    decoder.decode_at(spans[1].0, spans[1].1).unwrap();
    let mut index = EntityIndex::default();
    index.insert(1, (source.len() + 10, 0));
    index.insert(9, spans[2]);
    index.insert(10, spans[3]);
    index.insert(11, (source.len() + 10, 0));
    decoder.set_entity_index(Arc::new(index));
    assert_eq!(decoder.decode_string_by_id_transient(1, 2).unwrap().as_deref(), Some("requested cache"));
    assert_eq!(decoder.decode_string_by_id_transient(9, 2).unwrap().as_deref(), Some("parsed cache"));
    assert!(decoder.decode_string_by_id_transient(10, 2).is_err());
    let original = decoder.decode_at_uncached(source.len() + 10, 0).unwrap_err();
    assert_eq!(decoder.decode_string_by_id_transient(11, 2).unwrap_err().to_string(), original.to_string());
    assert_eq!(decoder.decode_string_by_id_transient(99, 2).unwrap_err().to_string(), "Parse error at position 0: Entity #99 not found");
    assert_eq!(decoder.cache_size(), 2);
}
