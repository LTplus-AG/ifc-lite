// SPDX-License-Identifier: MPL-2.0
//! The Part 21 header section.
//!
//! Its own module because it is its own thing: `HEADER` describes the file --
//! who wrote it, with what, against which schema -- while `DATA` is the model.
//! They share only the writer.

use std::io::Write;

use crate::step_text::escape;
use crate::StepOptions;

/// Write `ISO-10303-21;` through `DATA;`, leaving `out` ready for records.
///
/// `schema` is resolved rather than read off `opts`: a `None` there means
/// "keep the source's", and only the caller has detected what that is.
pub(crate) fn write_header<W: Write>(
    out: &mut W,
    opts: &StepOptions,
    schema: &str,
) -> std::io::Result<()> {
    out.write_all(b"ISO-10303-21;\nHEADER;\n")?;
    writeln!(out, "FILE_DESCRIPTION(('{}'),'2;1');", escape(&opts.description))?;
    writeln!(
        out,
        "FILE_NAME('','',('{}'),('{}'),'{}','ifc-lite-export','');",
        escape(&opts.author),
        escape(&opts.organization),
        escape(&opts.application),
    )?;
    writeln!(out, "FILE_SCHEMA(('{}'));", escape(schema))?;
    out.write_all(b"ENDSEC;\nDATA;\n")
}
