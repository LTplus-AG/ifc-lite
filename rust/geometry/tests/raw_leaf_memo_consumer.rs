// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_core::{EntityDecoder, EntityIndex};
use ifc_lite_geometry::placement::Axis2Placement;
use std::sync::Arc;

fn indexed(content: &str, point: (usize, usize), placement: (usize, usize)) -> EntityIndex {
    let mut index = EntityIndex::default();
    index.insert(1, point);
    index.insert(3, placement);
    assert!(placement.1 <= content.len());
    index
}

// #7779: a point cached as a raw success cannot become a valid direction.
// The invalid record reaches the production reader, which must refuse it;
// the positive control is a parsed valid direction with an analytic frame.
#[test]
fn issue_7779_memo_kind_is_observable_in_real_parsed_placement_frames() {
    let content = "#1=IFCCARTESIANPOINT((10.,20.));\n\
        #2=IFCDIRECTION((0.,1.));\n\
        #3=IFCAXIS2PLACEMENT2D(#1,#1);\n\
        #4=IFCAXIS2PLACEMENT2D(#1,#2);";
    let mut d = EntityDecoder::new(content);
    assert!(Axis2Placement::read_id(3, &mut d).is_err(), "point reused as direction");
    assert_eq!(d.refused_record_ids(), vec![1]);
    let matrix = Axis2Placement::read_id(4, &mut d).unwrap().matrix();
    assert_eq!((matrix[(0, 3)], matrix[(1, 3)]), (10.0, 20.0));
    assert_eq!((matrix[(0, 0)], matrix[(1, 0)]), (0.0, 1.0));
}

// #7779: the same requested id may select another immutable record. The
// resulting translation must follow the CURRENT index, including after a hit.
#[test]
fn issue_7779_memo_span_identity_controls_real_parsed_placement_translation() {
    let first = "#1=IFCCARTESIANPOINT((1.,2.));\n";
    let second = "#1=IFCCARTESIANPOINT((7.,8.));\n";
    let placement = "#3=IFCAXIS2PLACEMENT2D(#1,$);";
    let content = format!("{first}{second}{placement}");
    let place_span = (first.len() + second.len(), content.len());
    let spans = [(0, first.len()), (first.len(), first.len() + second.len())];
    let mut d = EntityDecoder::with_index(&content, indexed(&content, spans[0], place_span));
    for (span, expected) in [(spans[0], (1.0, 2.0)), (spans[1], (7.0, 8.0)), (spans[0], (1.0, 2.0))] {
        d.set_entity_index(Arc::new(indexed(&content, span, place_span)));
        for _ in 0..2 {
            let m = Axis2Placement::read_id(3, &mut d).unwrap().matrix();
            assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (expected.0, expected.1, 0.0));
            assert_eq!((m[(0, 0)], m[(1, 1)], m[(2, 2)]), (1.0, 1.0, 1.0));
        }
    }
}

// #7779: identical starting address is insufficient if a replacement index
// expands the selected slice. This intentionally exercises caller-supplied
// spans; it preserves the existing fast grammar rather than validating indexes.
#[test]
fn issue_7779_memo_span_length_cannot_hide_a_malformed_placement_origin() {
    let prefix = "#1=IFCCARTESIANPOINT((1.,2.,3.))";
    let bad = format!("{prefix});\n");
    let placement = "#3=IFCAXIS2PLACEMENT3D(#1,$,$);";
    let content = format!("{bad}{placement}");
    let place_span = (bad.len(), content.len());
    let mut d = EntityDecoder::with_index(&content,
        indexed(&content, (0, prefix.len()), place_span));
    let m = Axis2Placement::read_id(3, &mut d).unwrap().matrix();
    assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (1.0, 2.0, 3.0));
    d.set_entity_index(Arc::new(indexed(&content, (0, bad.len()), place_span)));
    assert!(Axis2Placement::read_id(3, &mut d).is_err(), "longer invalid origin reused a short success");
    d.clear_cache();
    assert!(Axis2Placement::read_id(3, &mut d).is_err(), "cache-clear negative control");
}
