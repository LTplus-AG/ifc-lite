// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_export::rhino::{RhinoSceneOptions, RhinoLayerScheme, RhinoUnits};

#[test]
fn rhino_json_options_preserve_defaults_and_validate_input() {
    let defaults: RhinoSceneOptions = serde_json::from_str("{}").unwrap();
    assert_eq!(defaults, RhinoSceneOptions::default());
    let options: RhinoSceneOptions = serde_json::from_str(r#"{"units":"feet","layerScheme":"class","isolated":[],"includeSpaces":false}"#).unwrap();
    assert_eq!(options.units, RhinoUnits::Feet);
    assert_eq!(options.layer_scheme, RhinoLayerScheme::Class);
    assert_eq!(options.isolated, Some(vec![]));
    assert!(!options.include_spaces);
    for invalid in [r#"{"unknown":true}"#, r#"{"units":"yards"}"#, r#"{"normals":null}"#, r#"{"hidden":[-1]}"#] {
        assert!(serde_json::from_str::<RhinoSceneOptions>(invalid).is_err());
    }
}
