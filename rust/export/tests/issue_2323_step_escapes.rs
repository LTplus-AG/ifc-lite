// SPDX-License-Identifier: MPL-2.0
//! #2323: STEP doubles BOTH escapes that are not backslash sequences — `''` is
//! one apostrophe and `\\` is one reverse solidus (ISO 10303-21). The Rust
//! attribute export collapsed neither, so `O'Brien` surfaced as `O''Brien` and
//! `C:\temp` as `C:\\temp` in CSV/JSON/JSON-LD/IFC5/Parquet and the wheel.
//!
//! These are WRONG VALUES, not cosmetic: an IDS check or a downstream join
//! against `O'Brien` silently fails to match `O''Brien`.

use ifc_lite_export::stream_export_model;

/// The issue's own reproduction file, byte-for-byte.
const MODEL: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#7=IFCWALL('1Ab1c2d3e4f5g6h7i8j9k0',$,'O''Brien Wall',$,$,$,$,$,$);
#9=IFCPROPERTYSET('2Ab1c2d3e4f5g6h7i8j9k0',$,'Pset_O''Brien',$,(#10,#11,#12,#13));
#10=IFCPROPERTYSINGLEVALUE('Apostrophe',$,IFCLABEL('O''Brien'),$);
#11=IFCPROPERTYSINGLEVALUE('Backslash',$,IFCLABEL('C:\\temp'),$);
#12=IFCPROPERTYSINGLEVALUE('Unicode',$,IFCLABEL('caf\X2\00E9\X0\'),$);
#13=IFCPROPERTYSINGLEVALUE('Mixed',$,IFCLABEL('a''b\\c'),$);
#14=IFCRELDEFINESBYPROPERTIES('3Ab1c2d3e4f5g6h7i8j9k0',$,$,$,(#7),#9);
ENDSEC;
END-ISO-10303-21;
"#;

fn wall_props() -> (Option<String>, Vec<(String, String)>, Vec<String>) {
    let mut rows = Vec::new();
    stream_export_model(MODEL, |r| rows.push(r));
    let wall = rows
        .iter()
        .find(|r| r.express_id == 7)
        .expect("#7 IfcWall gets an attribute row");
    let props = wall
        .property_sets
        .iter()
        .flat_map(|ps| ps.properties.iter())
        .map(|p| (p.name.clone(), p.value.clone()))
        .collect();
    let pset_names = wall.property_sets.iter().map(|ps| ps.name.clone()).collect();
    (wall.name.clone(), props, pset_names)
}

#[test]
fn issue_2323_wanted_values() {
    let (name, props, pset_names) = wall_props();
    let get = |k: &str| -> String {
        props
            .iter()
            .find(|(n, _)| n == k)
            .unwrap_or_else(|| panic!("property {k} present; got {props:?}"))
            .1
            .clone()
    };

    // The issue's want column, verbatim.
    assert_eq!(get("Apostrophe"), "O'Brien", "'' is ONE apostrophe");
    assert_eq!(get("Backslash"), r"C:\temp", r"\\ is ONE reverse solidus");
    assert_eq!(get("Unicode"), "caf\u{e9}", r"\X2\ already worked — must not regress");
    assert_eq!(get("Mixed"), r"a'b\c", "both escapes in one value");
    assert_eq!(name.as_deref(), Some("O'Brien Wall"), "entity Name is affected too");
    assert_eq!(pset_names, vec!["Pset_O'Brien".to_string()], "pset name too");
}

/// Bounding control: nothing without an escape may change, and the `''` escape
/// must not OVER-collapse — `''''` is two literal apostrophes, not one.
#[test]
fn issue_2323_bounding_controls() {
    const M: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#7=IFCWALL('1Ab1c2d3e4f5g6h7i8j9k0',$,'Plain Wall Name',$,$,$,$,$,$);
#9=IFCPROPERTYSET('2Ab1c2d3e4f5g6h7i8j9k0',$,'Pset_Plain',$,(#10,#11,#12));
#10=IFCPROPERTYSINGLEVALUE('NoEscapes',$,IFCLABEL('C/D-E_F 12 (g)'),$);
#11=IFCPROPERTYSINGLEVALUE('FourQuotes',$,IFCLABEL(''''''),$);
#12=IFCPROPERTYSINGLEVALUE('UnknownEscape',$,IFCLABEL('a\Qb'),$);
#14=IFCRELDEFINESBYPROPERTIES('3Ab1c2d3e4f5g6h7i8j9k0',$,$,$,(#7),#9);
ENDSEC;
END-ISO-10303-21;
"#;
    let mut rows = Vec::new();
    stream_export_model(M, |r| rows.push(r));
    let wall = rows.iter().find(|r| r.express_id == 7).expect("#7 row");
    let props: Vec<(String, String)> = wall
        .property_sets
        .iter()
        .flat_map(|ps| ps.properties.iter())
        .map(|p| (p.name.clone(), p.value.clone()))
        .collect();
    let get = |k: &str| props.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());

    assert_eq!(wall.name.as_deref(), Some("Plain Wall Name"));
    assert_eq!(get("NoEscapes").as_deref(), Some("C/D-E_F 12 (g)"));
    // `''''` (four raw quotes) is TWO literal apostrophes. One un-doubling pass
    // only; a second would over-collapse this to one.
    assert_eq!(get("FourQuotes").as_deref(), Some("''"));
    // An unrecognised backslash escape is still passed through unchanged.
    assert_eq!(get("UnknownEscape").as_deref(), Some(r"a\Qb"));
}
