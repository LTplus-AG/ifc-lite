// SPDX-License-Identifier: MPL-2.0
//! The Part 21 header section.
//!
//! Its own module because it is its own thing: `HEADER` describes the file --
//! who wrote it, with what, against which schema -- while `DATA` is the model.
//! They share only the writer.
//!
//! Twin of `buildStepHeader` (`packages/export/src/step-header.ts`) and the
//! `generateHeader` it delegates to (`packages/data/src/step-serializers.ts`).
//! The two are pinned to one another by the shared vectors in
//! `rust/export/tests/fixtures/step_header_vectors.json`.

use std::io::Write;

use crate::source_header::SourceHeader;
use crate::step_text::escape;
use crate::StepOptions;

/// Write one quoted, escaped list: `('a','b')`, or `()` for an empty one.
///
/// An empty list and an ABSENT list are different here, and the difference is
/// the TypeScript twin's: `generateHeader`'s `toList(v, [''])` substitutes the
/// `('')` fallback only when the field is `undefined`, so a source file that
/// really carried `FILE_NAME(...,(),(),...)` round-trips as `()` rather than
/// being back-filled with an empty author. Callers pass `None` for absent.
fn quote_list(items: Option<&[String]>) -> String {
    let items = match items {
        None => return "('')".to_string(),
        Some(items) => items,
    };
    if items.is_empty() {
        return "()".to_string();
    }
    let inner: Vec<String> = items.iter().map(|s| format!("'{}'", escape(s))).collect();
    format!("({})", inner.join(","))
}

/// Write `ISO-10303-21;` through `DATA;`, leaving `out` ready for records.
///
/// `schema` is resolved rather than read off `opts`: a `None` there means
/// "keep the source's", and only the caller has detected what that is.
///
/// `source` is the header the input file carried, when it carried one. It is
/// the reason this takes three arguments instead of two: a re-export that
/// invents its own `FILE_DESCRIPTION` and blanks `FILE_NAME` does not merely
/// lose provenance, it makes a false statement. Writing the default
/// `'ViewDefinition [CoordinationView]'` over a file whose header said
/// `'ViewDefinition [CoordinationView_V2.0]'` asserts a different MVD than the
/// model was authored for, and ISO 10303-21 clause 8 gives `FILE_NAME`'s
/// `time_stamp` as the date and time of file creation -- `''` is not one.
///
/// Precedence is the TypeScript twin's, field for field: an explicit option
/// wins, else the source's value, else the documented default. The one
/// deliberate difference is `time_stamp`: with no option the twin stamps *now*,
/// which this half cannot do (`SystemTime::now` is not available on the
/// `wasm32-unknown-unknown` target this exporter ships to), so it carries the
/// source's stamp forward instead. Both halves agree whenever the caller states
/// a stamp, which is what the shared vectors pin.
pub(crate) fn write_header<W: Write>(
    out: &mut W,
    opts: &StepOptions,
    source: Option<&SourceHeader>,
    schema: &str,
) -> std::io::Result<()> {
    // FILE_DESCRIPTION items: an explicit option wins, else the source items
    // verbatim, else the generic default.
    let description: Vec<String> = match &opts.description {
        Some(d) => vec![d.clone()],
        None => match source.filter(|s| !s.description.is_empty()) {
            Some(s) => s.description.clone(),
            // Not `ViewDefinition [CoordinationView]`, which is what this half
            // used to write over every file it re-exported: that string is an
            // MVD CLAIM, and asserting a view definition for a file that stated
            // none is a statement about the model's content that the exporter
            // is in no position to make. The twin says only where the file came
            // from, and so does this.
            None => vec!["Exported from ifc-lite".to_string()],
        },
    };
    let implementation_level = source
        .map(|s| s.implementation_level.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("2;1");

    let filename = opts.filename.as_deref().unwrap_or("export.ifc");
    // No option and no source stamp leaves the field empty, as before. An empty
    // `time_stamp` is not valid Part 21, but inventing one would be a claim
    // about when a file nobody stamped was created.
    let time_stamp =
        opts.time_stamp.clone().or_else(|| source.and_then(|s| s.time_stamp.clone()));
    let time_stamp = time_stamp.as_deref().unwrap_or("");

    let author: Option<Vec<String>> = match &opts.author {
        Some(a) => Some(vec![a.clone()]),
        None => source.map(|s| s.author.clone()),
    };
    let organization: Option<Vec<String>> = match &opts.organization {
        Some(o) => Some(vec![o.clone()]),
        None => source.map(|s| s.organization.clone()),
    };

    // preprocessor_version = the tool that WROTE this file (ifc-lite);
    // originating_system keeps the source authoring tool so it isn't erased.
    let application = opts.application.as_deref().unwrap_or("ifc-lite");
    let originating_system = source
        .and_then(|s| s.originating_system.as_deref())
        .filter(|s| !s.is_empty())
        .unwrap_or(application);
    let authorization =
        source.and_then(|s| s.authorization.as_deref()).unwrap_or("");

    out.write_all(b"ISO-10303-21;\nHEADER;\n")?;
    writeln!(
        out,
        "FILE_DESCRIPTION({},'{}');",
        quote_list(Some(&description)),
        escape(implementation_level)
    )?;
    writeln!(
        out,
        "FILE_NAME('{}','{}',{},{},'{}','{}','{}');",
        escape(filename),
        escape(time_stamp),
        quote_list(author.as_deref()),
        quote_list(organization.as_deref()),
        escape(application),
        escape(originating_system),
        escape(authorization),
    )?;
    writeln!(out, "FILE_SCHEMA(('{}'));", escape(schema))?;
    out.write_all(b"ENDSEC;\nDATA;\n")
}
