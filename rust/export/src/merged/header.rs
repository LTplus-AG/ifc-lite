// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `HEADER` section the merged exporter writes, through `DATA;`.

use super::MergedOptions;
use crate::step_text::escape;

/// `schema` is the resolved target label. An explicit target family declares
/// its file identifier (IFC4X3 is written as IFC4X3_ADD2, #5351); a label read
/// off the first model (`opts.schema` is `None`) is that file's own token and
/// is kept verbatim.
pub(super) fn merged_header(opts: &MergedOptions, schema: &str) -> String {
    let declared = if opts.schema.is_some() {
        crate::file_schema::file_schema_identifier(schema)
    } else {
        schema
    };
    let mut out = String::new();
    out.push_str("ISO-10303-21;\nHEADER;\n");
    out.push_str(&format!("FILE_DESCRIPTION(('{}'),'2;1');\n", escape(&opts.description)));
    out.push_str(&format!(
        "FILE_NAME('','',(''),(''),'{}','ifc-lite-export','');\n",
        escape(&opts.application)
    ));
    out.push_str(&format!("FILE_SCHEMA(('{}'));\n", escape(declared)));
    out.push_str("ENDSEC;\nDATA;\n");
    out
}
