// SPDX-License-Identifier: MPL-2.0
#[path = "../examples/compare/tolerances.rs"]
mod tolerances;
use serde_json::json;

// #7955: exercise the same disk loader as the comparison harness, without an engine.
#[test]
fn slice_keys_merge_and_duplicate_keys_name_both_owners() {
    let root = std::env::temp_dir().join(format!("ifc-tolerances-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
    }
    let _cleanup = Cleanup(root.clone());
    std::fs::write(root.join("tolerances.json"), r#"{"base":{"absolute":0.001}}"#).unwrap();
    assert_eq!(tolerances::load(&root).unwrap(), json!({"base":{"absolute":0.001}}));
    let fragments = root.join("tolerances.d");
    std::fs::create_dir(&fragments).unwrap();
    std::fs::write(fragments.join("a.json"), r#"{"slice":false}"#).unwrap();
    std::fs::write(fragments.join("b.json"), r#"{"other":null}"#).unwrap();
    assert_eq!(tolerances::load(&root).unwrap(), json!({"base":{"absolute":0.001},"slice":false,"other":null}));
    for (value, owner) in [(r#"{"base":{"relative":1}}"#, "tolerances.json"), (r#"{"slice":false}"#, "a.json")] {
        std::fs::write(fragments.join("b.json"), value).unwrap();
        let error = tolerances::load(&root).unwrap_err().to_string();
        assert!(error.contains(owner) && error.contains("b.json") && error.contains("Duplicate tolerance"), "{error}");
    }
    std::fs::write(fragments.join("b.json"), "[]").unwrap();
    assert!(tolerances::load(&root).unwrap_err().to_string().contains("expected a tolerance object"));
    assert_eq!(tolerances::registered().unwrap()["nativeWasmVolumeRelative"], json!(1e-9));
}
