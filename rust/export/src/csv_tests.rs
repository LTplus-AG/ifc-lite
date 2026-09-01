// SPDX-License-Identifier: MPL-2.0
//! Tests for `csv.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the production module stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.


/// `escape` spells its options out rather than using
/// `..CsvCellOptions::default()`, so a NEW option on a security-relevant
/// guard cannot be inherited without someone deciding. The cost is that
/// this writer does NOT follow the shared default automatically: the
/// "DEFAULT OPTIONS" vectors in the shared fixture pin every TypeScript
/// writer against `escape_csv_cell`'s default and would not notice this one
/// drifting away from it.
///
/// So pin the WRITER, not the default. Asserting
/// `CsvCellOptions::default().exempt_numbers` would still pass if this
/// function stopped honouring it.
#[test]
fn escape_exempts_a_wholly_numeric_cell_and_guards_everything_else() {
    // #1772: a negative measure must reach a spreadsheet as a number, or
    // the column stops summing.
    assert_eq!(escape("-0.35", ","), "-0.35");
    assert_eq!(escape("+1", ","), "+1");
    // The exemption is for numbers, not for the sign.
    assert_eq!(escape("-0.35=cmd", ","), "'-0.35=cmd");
    assert_eq!(escape("=1+1", ","), "'=1+1");
    assert_eq!(escape("@SUM(A1)", ","), "'@SUM(A1)");
    // Still RFC 4180 on top of the guard.
    assert_eq!(escape("a,b", ","), "\"a,b\"");
}

use super::*;

/// A minimal, independent RFC-4180 field splitter for ONE line — deliberately
/// NOT `escape_csv_cell`'s own logic, and deliberately not the `csv-parse`
/// npm package (kept out of this repo on purpose): this is the oracle the
/// writer is graded against, so it must not share code with the thing it is
/// checking. Handles a quoted field with embedded delimiters/quotes
/// (`""` -> `"`); does not span embedded raw newlines, which none of the
/// values in `adversarial_row_survives_the_real_export_pipeline` below
/// contain (RFC 4180 §2.6/§2.7).
fn parse_rfc4180_line(line: &str, delim: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        let mut field = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            loop {
                match chars.next() {
                    Some('"') => {
                        if chars.peek() == Some(&'"') {
                            field.push('"');
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    Some(c) => field.push(c),
                    None => break,
                }
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c == delim {
                    break;
                }
                field.push(c);
                chars.next();
            }
        }
        fields.push(field);
        match chars.next() {
            Some(c) if c == delim => continue,
            Some(_) => unreachable!("stray character after a closed quoted field"),
            None => break,
        }
    }
    fields
}

/// A wall named `Wall "A", B` (RFC 4180 quote + delimiter), a formula-
/// injection description (`=SUM(A1)`), and a `Pset_Adversarial` property
/// whose Cyrillic NAME (#3556: non-ASCII must survive) carries a VALUE that
/// combines a formula trigger, a comma AND a quote in one cell
/// (`=1+1,"x"`) — exercised through the REAL `build_export_model` ->
/// `entities_csv`/`properties_csv` pipeline (STEP bytes in, CSV text out),
/// not by calling `escape()` on a hand-picked literal. Every field is
/// decoded back with an INDEPENDENT RFC-4180 splitter and checked against
/// the exact source string: a delimiter/quote that leaked past the quoting
/// would show up here as a field that decodes to the wrong (truncated or
/// merged) value, or as a row with the wrong field count.
#[test]
fn adversarial_row_survives_the_real_export_pipeline() {
    let name = "Wall \"A\", B";
    let description = "=SUM(A1)";
    // \X2\...\X0\: buildingSMART's ISO-10303-21 6.3.3.4 encoding for a
    // character outside decimal 32-126 (see `step_text::escape`'s doc
    // comment) -- "Ставка" (Cyrillic, #3556).
    let prop_name_encoded = "\\X2\\0421044204300432043A0430\\X0\\";
    let prop_name_decoded = "Ставка";
    let prop_value = "=1+1,\"x\"";

    let ifc = format!(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
         #2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
         #3=IFCUNITASSIGNMENT((#1,#2));\n\
         #4=IFCPROJECT('0PROJECT0000000000000',$,'P',$,$,$,$,$,#3);\n\
         #5=IFCWALL('0WALL000000000000000A',$,'{name}','{description}',$,$,$,$,$);\n\
         #10=IFCPROPERTYSINGLEVALUE('{prop_name_encoded}',$,IFCLABEL('{prop_value}'),$);\n\
         #11=IFCPROPERTYSET('0PSET00000000000000A',$,'Pset_Adversarial',$,(#10));\n\
         #12=IFCRELDEFINESBYPROPERTIES('0REL000000000000000A',$,$,$,(#5),#11);\n\
         ENDSEC;\n\
         END-ISO-10303-21;\n",
    );

    // --- Entities view: Name + Description columns ---
    let entities = export_csv(ifc.as_bytes(), CsvMode::Entities, &CsvOptions::default());
    let mut lines = entities.lines();
    let header = parse_rfc4180_line(lines.next().unwrap(), ',');
    let name_col = header.iter().position(|h| h == "name").unwrap();
    let desc_col = header.iter().position(|h| h == "description").unwrap();
    let wall_line = lines.find(|l| l.contains("0WALL")).expect("wall row present");
    let fields = parse_rfc4180_line(wall_line, ',');
    assert_eq!(fields.len(), header.len(), "wall row must have exactly as many fields as the header");
    assert_eq!(fields[name_col], name, "the quote+comma name must round-trip exactly");
    // The formula guard prefixes an apostrophe; strip it before comparing.
    assert_eq!(
        fields[desc_col].trim_start_matches('\''),
        description,
        "the formula-guarded description must decode back to the source text"
    );

    // --- Properties view: psetName/propName/value columns ---
    let properties = export_csv(ifc.as_bytes(), CsvMode::Properties, &CsvOptions::default());
    let mut plines = properties.lines();
    let pheader = parse_rfc4180_line(plines.next().unwrap(), ',');
    let prop_name_col = pheader.iter().position(|h| h == "propName").unwrap();
    let value_col = pheader.iter().position(|h| h == "value").unwrap();
    let prow = plines.next().expect("one property row");
    let pfields = parse_rfc4180_line(prow, ',');
    assert_eq!(pfields.len(), pheader.len(), "property row must have exactly as many fields as the header");
    assert_eq!(
        pfields[prop_name_col], prop_name_decoded,
        "the \\X2\\ Cyrillic property name must decode back to the source text (#3556)"
    );
    assert_eq!(
        pfields[value_col].trim_start_matches('\''),
        prop_value,
        "a value combining a formula trigger, a comma AND a quote must decode back to the source text"
    );
}

#[test]
fn entities_csv_has_header_and_rows() {
    let csv = export_csv(&fixture_or_skip!("ara3d/duplex.ifc"), CsvMode::Entities, &CsvOptions::default());
    let mut lines = csv.lines();
    assert_eq!(lines.next().unwrap(), "expressId,globalId,name,type,description,objectType,hasGeometry");
    assert!(csv.lines().count() > 50, "expected many product rows");
    // Each data row has exactly 7 native columns (no flatten).
    for line in csv.lines().skip(1).take(20) {
        // commas inside quotes are possible; do a light field-count via a simple split is unsafe,
        // so just assert the row starts with a numeric expressId.
        assert!(line.chars().next().unwrap().is_ascii_digit());
    }
}

#[test]
fn flatten_adds_property_columns() {
    let plain = export_csv(&fixture_or_skip!("ara3d/duplex.ifc"), CsvMode::Entities, &CsvOptions::default());
    let flat = export_csv(
        &fixture_or_skip!("ara3d/duplex.ifc"),
        CsvMode::Entities,
        &CsvOptions { include_properties: true, ..CsvOptions::default() },
    );
    let plain_cols = plain.lines().next().unwrap().split(',').count();
    let flat_cols = flat.lines().next().unwrap().split(',').count();
    assert!(flat_cols > plain_cols, "flatten should add Pset_Prop columns");
}

#[test]
fn properties_csv_one_row_per_value() {
    let csv = export_csv(&fixture_or_skip!("ara3d/duplex.ifc"), CsvMode::Properties, &CsvOptions::default());
    assert_eq!(
        csv.lines().next().unwrap(),
        "entityId,globalId,entityName,entityType,psetName,propName,value,type"
    );
    assert!(csv.lines().count() > 1, "expected property rows");
}

#[test]
fn spatial_hierarchy_csv() {
    let csv = export_csv(
        &fixture_or_skip!("ara3d/duplex.ifc"),
        CsvMode::SpatialHierarchy,
        &CsvOptions::default(),
    );
    assert_eq!(csv.lines().next().unwrap(), "expressId,globalId,name,type,parentId,level");
    assert!(csv.contains(",IfcProject,"), "project row present");
    assert!(csv.lines().count() > 3, "expected spatial nodes");
    // Exactly one root at level 0 (the project, with an empty parentId).
    let level0 = csv.lines().skip(1).filter(|l| l.ends_with(",0")).count();
    assert_eq!(level0, 1, "single root at level 0");
    // Storeys/spaces appear deeper in the tree.
    assert!(csv.contains("IfcBuildingStorey"), "storeys present in the hierarchy");
}

#[test]
fn formula_injection_is_guarded() {
    assert_eq!(escape("=SUM(A1)", ","), "'=SUM(A1)");
    assert_eq!(escape("a,b", ","), "\"a,b\"");
    assert_eq!(escape("he\"llo", ","), "\"he\"\"llo\"");
    assert_eq!(escape("plain", ","), "plain");
}

/// The four CommandPalette CSV downloads in the viewer come out of this
/// module, which makes it the highest-traffic CSV writer in the repo — and
/// until the guard moved to `csv_cell`, every one of these inputs was
/// exported with a live formula, because the trigger test was anchored at
/// offset 0 and each of these hides it behind an invisible.
#[test]
fn an_invisible_cannot_hide_a_formula_trigger_from_the_entities_writer() {
    for (label, lead) in [
        ("BOM", '\u{FEFF}'),
        ("ZWSP", '\u{200B}'),
        ("LRM", '\u{200E}'),
        ("NBSP", '\u{00A0}'),
        ("LINE SEPARATOR", '\u{2028}'),
        ("SPACE", ' '),
    ] {
        let payload = format!("{lead}=cmd|'/c calc'!A1");
        assert_eq!(
            escape(&payload, ","),
            format!("'{payload}"),
            "{label} must not hide the trigger"
        );
    }
}

/// RFC 4180 §2.4: "Spaces are considered part of a field and should not be
/// ignored." The hardened TypeScript copies this crate is now aligned with
/// bought their invisible-handling by DELETING the leading run, which threw
/// leading spaces away on every benign cell. Looking past without deleting
/// is what makes the two compatible.
#[test]
fn a_benign_cell_keeps_its_leading_whitespace_and_bom() {
    assert_eq!(escape("   Wall A", ","), "   Wall A");
    assert_eq!(escape("\u{FEFF}Wall A", ","), "\u{FEFF}Wall A");
    assert_eq!(escape("\u{200B}\u{200B}Wall", ","), "\u{200B}\u{200B}Wall");
}

/// A configured delimiter must drive the quoting decision — a cell with a
/// comma is NOT special when the file is semicolon-separated.
#[test]
fn quoting_follows_the_configured_delimiter() {
    assert_eq!(escape("a,b", ";"), "a,b");
    assert_eq!(escape("a;b", ";"), "\"a;b\"");
}
