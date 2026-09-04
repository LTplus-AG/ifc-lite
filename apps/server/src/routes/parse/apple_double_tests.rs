// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `is_apple_double`, in a ratchet-exempt sibling file like
//! every other test module here.

use super::is_apple_double;

// macOS Finder writes `__MACOSX/._<name>` beside each entry when
// compressing, keeping the original extension - so it matched the .ifc
// filter and every Mac-made archive was rejected as containing two models
// (#2812).
#[test]
fn recognises_the_macosx_directory_sidecar() {
    assert!(is_apple_double("__MACOSX/._model.ifc"));
    assert!(is_apple_double("project/__MACOSX/._model.ifc"));
}

// Several unzip/rezip round trips drop the directory but keep the sidecar
// next to its original, so the prefix alone is not enough.
#[test]
fn recognises_a_bare_sidecar_beside_its_original() {
    assert!(is_apple_double("._model.ifc"));
    assert!(is_apple_double("project/._model.ifc"));
}

// The ambiguity error exists for a reason: skipping sidecars must not skip
// a real second model, including one in a folder or one whose name merely
// contains the marker.
#[test]
fn leaves_genuine_models_alone() {
    assert!(!is_apple_double("model.ifc"));
    assert!(!is_apple_double("project/model.ifc"));
    assert!(!is_apple_double("nested/b.ifc"));
    // A file NAMED after the marker is still content.
    assert!(!is_apple_double("__MACOSX_backup.ifc"));
    // ...and so is a real model inside a folder called `__MACOSX`. The
    // sidecar test is the basename; matching the directory would drop it.
    assert!(!is_apple_double("__MACOSX/model.ifc"));
    // ...and `._` INSIDE a name is not a sidecar prefix: only a basename
    // that STARTS with it is.
    assert!(!is_apple_double("v1._final.ifc"));
}
