// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F4-3 (#7778, CORE-1): the raw fast readers answer what the full decode
//! answers. Each row is a record the old byte-scan preludes read wrongly:
//! a comment with a `(` or a `#` in it, a `#` inside a string, a leading `$`.
//! The fast reader must give the decoded value or `None`, never a different
//! value.

use ifc_lite_core::{AttributeValue, EntityDecoder};

fn decoded_point(decoder: &mut EntityDecoder, id: u32) -> Option<(f64, f64, f64)> {
    let entity = decoder.decode_by_id(id).ok()?;
    let coords = entity.get(0)?.as_list()?;
    let at = |i: usize| coords.get(i).and_then(AttributeValue::as_float);
    (2..=3).contains(&coords.len()).then_some(())?;
    Some((at(0)?, at(1)?, at(2).unwrap_or(0.0)))
}

#[test]
fn the_point_reader_agrees_with_the_decode() {
    let records = [
        "#1=IFCCARTESIANPOINT((1.,2.,3.));",
        "#2=IFCCARTESIANPOINT(/* (9.) */(1.,2.,3.));",
        "#3=IFCCARTESIANPOINT(( 4. /* , */ , 5., 6. ));",
        "#4=IFCCARTESIANPOINT((.5,1E1));",
        "#5= /* x */ IFCCARTESIANPOINT /* ( */ ((1.,2.,3.));",
        "#6=IFCCARTESIANPOINT((1.,2.,3.,4.));",
        "#7=IFCCARTESIANPOINT((1.52.3,2.,3.));",
        "#8=IFCCARTESIANPOINT($);",
    ];
    let content = records.join("\n");
    let mut decoder = EntityDecoder::new(&content);
    let mut agreed = 0;
    for id in 1..=records.len() as u32 {
        let fast = decoder.get_cartesian_point_fast(id);
        match decoded_point(&mut decoder, id) {
            Some(decoded) => {
                assert_eq!(fast, Some(decoded), "#{id}");
                agreed += 1;
            }
            None => assert_eq!(fast, None, "#{id}"),
        }
    }
    assert!(agreed >= 5, "the control rows must decode: {agreed}");
}

#[test]
fn the_list_readers_agree_with_the_decode() {
    let content = "\
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((1.,0.,0.));
#3=IFCCARTESIANPOINT((0.,1.,0.));
#10=IFCPOLYLOOP((#1,#2,#3));
#11=IFCPOLYLOOP(/* (#9) */(#1,/* #8, */#2,#3));
#12=IFCPOLYLOOP(('#9',#1,#2,#3));
#13=IFCFACEOUTERBOUND(/*#9*/#10,.F.);
#14=IFCFACEBOUND(#10,$);
#15=IFCFACEOUTERBOUND(#10,.T.);
#20=IFCCLOSEDSHELL((#13,#14,/* #9 */#15));
";
    let mut decoder = EntityDecoder::new(content);
    assert_eq!(decoder.get_polyloop_point_ids_fast(10), Some(vec![1, 2, 3]));
    // A comment is trivia: the loop is the loop the decode reads.
    assert_eq!(decoder.get_polyloop_point_ids_fast(11), Some(vec![1, 2, 3]));
    assert_eq!(decoder.get_polyloop_coords_cached(11).map(|p| p.len()), Some(3));
    // A string is not a reference: the loop is refused, not read without it.
    assert_eq!(decoder.get_polyloop_point_ids_fast(12), None);
    assert_eq!(decoder.get_polyloop_coords_cached(12), None);
    // Face bounds: the comment holds a `#9` that is not the loop.
    assert_eq!(decoder.get_face_bound_fast(13), Some((10, false, true)));
    assert_eq!(decoder.get_face_bound_fast(14), Some((10, true, false)));
    assert_eq!(decoder.get_face_bound_fast(15), Some((10, true, true)));
    assert_eq!(decoder.get_entity_ref_list_fast(20), Some(vec![13, 14, 15]));
    // The decode agrees on every list.
    let shell = decoder.decode_by_id(20).unwrap();
    let ids: Vec<u32> = shell.get(0).unwrap().as_list().unwrap().iter().filter_map(AttributeValue::as_entity_ref).collect();
    assert_eq!(ids, [13, 14, 15]);
}
