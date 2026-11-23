// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use std::process::Command;

use ifc_lite_cache::FORMAT_VERSION;

#[test]
fn issue_11337_version_flags_report_crate_and_cache_format_versions() {
    let expected = format!(
        "ifc-build-cache {} (format v{FORMAT_VERSION})\n",
        env!("CARGO_PKG_VERSION")
    );
    for flag in ["--version", "-V"] {
        let output = Command::new(env!("CARGO_BIN_EXE_ifc-build-cache"))
            .arg(flag)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(0), "{flag}: {output:?}");
        assert_eq!(output.stdout, expected.as_bytes(), "{flag}");
        assert!(output.stderr.is_empty(), "{flag}: {output:?}");
    }
}
