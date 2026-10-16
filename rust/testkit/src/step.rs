// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! In-memory STEP file builder for tests.

/// A complete STEP physical file with a real `FILE_DESCRIPTION`/`FILE_NAME`
/// header (real files always carry both) declaring `schema` (e.g. `"IFC4"`),
/// whose `DATA` section is `lines` joined by newlines. Each element of
/// `lines` (`&[&str]` or `&[String]`) is one entity line, e.g. `"#1=IFCPROJECT(...);"`.
pub fn step_file<S: AsRef<str>>(schema: &str, lines: &[S]) -> String {
    let mut out = format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('{schema}'));\nENDSEC;\nDATA;\n"
    );
    for line in lines {
        out.push_str(line.as_ref());
        out.push('\n');
    }
    out.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    out
}

#[cfg(test)]
mod tests {
    use super::step_file;

    #[test]
    fn wraps_lines_in_a_full_header_and_trailer() {
        let s = step_file("IFC4X3", &["#1=IFCPROJECT($);", "#2=IFCSITE($);"]);
        assert!(s.starts_with("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION("));
        assert!(s.contains("FILE_SCHEMA(('IFC4X3'));"));
        assert!(s.contains("DATA;\n#1=IFCPROJECT($);\n#2=IFCSITE($);\nENDSEC;\nEND-ISO-10303-21;\n"));
    }
}
