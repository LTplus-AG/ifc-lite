// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{EntityDecoder, Error};

const CONTENT: &str = "\
#1=IFCCARTESIANPOINT((1.,2.,3.));
#2=IFCCARTESIANPOINT((1.5,-2.));
#3=ifccartesianpoint /* c */ ( ( 1 , 2 , 3 ) ) ;
#4=IFCDIRECTION((0.,0.,0.));
#5=IFCDIRECTION((1.,2.));
#6=IFCCARTESIANPOINT((1.,2.,3.,4.));
#7=IFCCARTESIANPOINT((1.));
#8=IFCCARTESIANPOINT((1.,$,3.));
#9=IFCCARTESIANPOINT((1.,'a',3.));
#10=IFCCARTESIANPOINT((1.,IFCLENGTHMEASURE(2.),3.));
#11=IFCCARTESIANPOINT(1.);
#12=IFCCARTESIANPOINT((1.,2.,3.),4);
#13=IFCDIRECTION((0.,0.,1.));
#14=IFCCARTESIANPOINT((1.,2.,3.)) ;
#20=IFCAXIS2PLACEMENT3D(#1,$,*);
#21=IFCAXIS2PLACEMENT3D(1.,#13,.T.);
#22=IFCCARTESIANPOINT((1.E400,0.,0.));
";

fn refused(d: &EntityDecoder, ids: &[u32]) -> bool {
    let mut got = d.refused_record_ids();
    got.sort_unstable();
    got == ids
}

#[test]
fn point_and_direction_read_two_or_three_numbers_and_promote_2d() {
    let mut d = EntityDecoder::new(CONTENT);
    assert_eq!(d.point3(1).unwrap(), [1.0, 2.0, 3.0]);
    assert_eq!(d.point3(2).unwrap(), [1.5, -2.0, 0.0], "2D point: z = 0 (D26)");
    assert_eq!(d.point3(3).unwrap(), [1.0, 2.0, 3.0], "lower case, comments, integers");
    assert_eq!(d.point3(14).unwrap(), [1.0, 2.0, 3.0]);
    assert_eq!(d.direction3(4).unwrap(), [0.0; 3], "raw ratios, zero allowed");
    assert_eq!(d.direction3(5).unwrap(), [1.0, 2.0, 0.0]);
    assert_eq!(d.refused_records(), 0);
}

#[test]
fn anything_else_is_a_counted_refusal() {
    let mut d = EntityDecoder::new(CONTENT);
    for id in [6, 7, 8, 9, 10, 11, 12] {
        assert!(matches!(d.point3(id), Err(Error::MalformedRecord(got)) if got == id), "#{id}");
    }
    // The wrong IFC type, in both directions.
    assert!(matches!(d.point3(13), Err(Error::MalformedRecord(13))));
    assert!(matches!(d.direction3(1), Err(Error::MalformedRecord(1))));
    assert!(refused(&d, &[1, 6, 7, 8, 9, 10, 11, 12, 13]));
    // Counted once however often it is re-read.
    let _ = d.point3(6);
    assert_eq!(d.refused_records(), 9);
}

#[test]
fn a_dangling_id_is_the_decode_error_and_not_counted() {
    let mut d = EntityDecoder::new(CONTENT);
    assert!(!matches!(d.point3(999), Ok(_) | Err(Error::MalformedRecord(_))));
    assert_eq!(d.refused_records(), 0);
}

#[test]
fn an_unrepresentable_real_keeps_its_own_error_and_the_same_counter() {
    let mut strict = EntityDecoder::new(CONTENT).with_strict_reals();
    assert!(matches!(strict.point3(22), Err(Error::UnrepresentableReal(22))));
    assert!(matches!(strict.point3(6), Err(Error::MalformedRecord(6))));
    assert_eq!(strict.refused_records(), 2);
    // A lossless decoder reads the infinity; a leaf is never non-finite.
    let mut lossless = EntityDecoder::new(CONTENT);
    assert!(matches!(lossless.point3(22), Err(Error::MalformedRecord(22))));
}

#[test]
fn slot_readers_split_absent_from_malformed() {
    let mut d = EntityDecoder::new(CONTENT);
    let placement = d.decode_by_id(20).unwrap();
    assert_eq!(d.point3_at(&placement, 0).unwrap(), Some([1.0, 2.0, 3.0]));
    assert_eq!(d.direction3_at(&placement, 1).unwrap(), None, "$");
    assert_eq!(d.direction3_at(&placement, 2).unwrap(), None, "*");
    assert_eq!(d.point3_at(&placement, 9).unwrap(), None, "past the end");
    assert!(d.resolve_optional(&placement, 1).unwrap().is_none());
    assert!(d.resolve_optional(&placement, 2).unwrap().is_none());
    assert_eq!(d.resolve_optional(&placement, 0).unwrap().unwrap().id, 1);
    assert_eq!(d.refused_records(), 0);

    let bad = d.decode_by_id(21).unwrap();
    assert!(matches!(d.point3_at(&bad, 0), Err(Error::MalformedRecord(21))));
    assert!(matches!(d.resolve_optional(&bad, 2), Err(Error::MalformedRecord(21))));
    assert_eq!(d.direction3_at(&bad, 1).unwrap(), Some([0.0, 0.0, 1.0]));
    assert!(refused(&d, &[21]));
}

/// The fast path may only miss, never disagree: a hit equals the full decode's
/// reading bit for bit, and a record the full decode cannot parse (`.5`, `1E5`,
/// an integer past `i64`, a stray `)`) is never a hit (review of #7818).
#[test]
fn the_fast_path_never_reads_what_the_full_decode_does_not() {
    use super::{fast_leaf, slow_leaf, DIRECTION_KEYWORD, POINT_KEYWORD};
    use crate::IfcType;
    let lists = [
        "((1.E3,2.e-3,-3.E+2))", "((-0.,0.,-0.))", "((1,2,3))", "((1.,2.))", "((.5,0.,0.))",
        "((-.5,0.))", "((1E5,0.,0.))", "((9999999999999999999999,0.,0.))", "((1.,2.,3.)))",
        "((1.,2.,3.)) /* c */ ", "((/*a*/1.,2./*b*/,3.))", "((+1.,+2.,+3.))", "((1.E400,0.,0.))",
        "((1.E-400,0.,0.))", "((1.,$,2.))", "(((1.),2.,3.))", "((1.))", "((1.,2.,3.,4.))", "(())",
        "((1.,2.,3.),$)", "((IFCREAL(1.),2.,3.))",
    ];
    let mut content = String::new();
    for (i, list) in lists.iter().enumerate() {
        content.push_str(&format!("#{}=IFCCARTESIANPOINT{list};\n#{}=ifcDirection{list};\n", 2 * i + 1, 2 * i + 2));
    }
    let mut d = EntityDecoder::new(&content);
    for id in 1..=2 * lists.len() as u32 {
        for (keyword, ifc_type) in
            [(POINT_KEYWORD, IfcType::IfcCartesianPoint), (DIRECTION_KEYWORD, IfcType::IfcDirection)]
        {
            let Some(fast) = d.get_raw_bytes(id).and_then(|bytes| fast_leaf(bytes, keyword)) else {
                continue;
            };
            let slow = d.decode_by_id(id).ok().and_then(|e| slow_leaf(&e, ifc_type.clone()));
            let bits = |v: [f64; 3]| v.map(f64::to_bits);
            assert_eq!(slow.map(bits), Some(bits(fast)), "#{id}: fast {fast:?}, slow {slow:?}");
        }
    }
}
