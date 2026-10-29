// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7781 C2-2: RTC keeps list ordering, lossy skips and speculative point reads.
use super::*;

#[test]
fn rtc_items_skip_malformed_entries_and_stop_at_first_fast_point() {
    for items in ["$,#999,#30,#31,#32", "#32,#31"] {
        let source = format!(
            "#1=IFCWALL('g',$,$,$,$,$,#2,$);\
            #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#10,#11,#12,#13));\
            #10=IFCSHAPEREPRESENTATION($,'Body','Brep');\
            #11=IFCSHAPEREPRESENTATION($,'Body','Brep',42);\
            #12=IFCSHAPEREPRESENTATION($,'Body','Brep',({items}));\
            #13=IFCSHAPEREPRESENTATION($,'Body','Brep',(#33));\
            #30=IFCFACETEDBREP(#999);\
            #31=IFCCARTESIANPOINT((1001.,2.,3.));\
            #32=IFCCARTESIANPOINT((2002.,4.,6.));\
            #33=IFCCARTESIANPOINT((3003.,6.,9.));"
        );
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1).unwrap();
        let expected = if items.starts_with('$') {
            (1001., 2., 3.)
        } else {
            (2002., 4., 6.)
        };
        assert_eq!(
            GeometryRouter::new().sample_first_geometry_vertex(&element, &mut decoder),
            Some(expected)
        );
        // Six structural records, plus the skipped Brep on the first ordering.
        // The successful fast point and everything after it remain undecoded.
        assert_eq!(decoder.cache_size(), if items.starts_with('$') { 7 } else { 6 });
    }
}

#[test]
fn rtc_speculative_point_read_precedes_item_type_admission() {
    // The raw point reader intentionally accepts a coordinate tuple before the
    // item kind is known. Moving decode/type dispatch first changes this vote.
    let source = "#1=IFCWALL('g',$,$,$,$,$,#2,$);\
        #2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));\
        #3=IFCSHAPEREPRESENTATION($,'Body','Brep',(#4,#5));\
        #4=IFCDIRECTION((1001.,2.,3.));#5=IFCCARTESIANPOINT((2002.,4.,6.));";
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(1).unwrap();
    assert_eq!(
        GeometryRouter::new().sample_first_geometry_vertex(&element, &mut decoder),
        Some((1001., 2., 3.))
    );
    assert_eq!(decoder.cache_size(), 3);
}
