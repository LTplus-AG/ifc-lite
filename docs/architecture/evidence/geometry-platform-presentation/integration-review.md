# Supplemental presentation integration review

Read-only static inspection of the parent's dirty presentation integration. No builds, tests, jobs, or edits to repository files. The source was not frozen by this reviewer; hashes below identify the inspected files. No compilation or executed lifetime-test result is claimed.

No new production correctness or static type objection found in the narrowed resource handles.

- Palette::Shared now retains exactly Arc<FxHashMap<u32, FullIndexedColourMap>> plus the selected key. presentation_palettes clones the existing immutable Arc, with no per-part map copy or decode. It preserves lookup timing and the distinction between selected key and embedded geometry_id.
- PresentationFrame::Shared now retains Option<Arc<Vec<f64>>>. presentation_rotation clones the existing optional rotation Arc, and rotation.as_deref gives the same Option<&Vec<f64>> consumed by the unchanged numerical funnel. None and nonidentity rotations follow the same arithmetic and ordering as before.
- ReadyPresentation's actual fields no longer carry OwnedMeshProductionContext, ProductionModel, SourceBundle, a decoder, or callbacks. The admission constructors accept a context reference only to select derived handles; the retained map and rotation element types contain no source/model authority. Shared metadata remains ordinary owned strings/properties captured in AssemblyJob.
- The updated actual textured-type packet test downgrades context and lets all lexical owners drop before asserting Weak::upgrade is None, then assembles the packet and compares output fields. The prior context-retaining frame variant would fail that assertion. This is a meaningful lifetime invariant, although unexecuted. The expected ProducedElementMeshes value contains output data rather than a model-context Arc, so it should not keep the context alive accidentally.
- The palette test now compares Arc::ptr_eq against the accessor's existing map Arc, destructures the exact Shared variant and checks its map after owner disposal. That proves map allocation reuse and retained derived data without requiring the model context to survive.

Coverage recommendation only: the packet lifetime test currently uses the default None site-local rotation. Add or retain a scene/invariant case with a nonidentity shared rotation to qualify normals, origins and dropped captured transforms after owner disposal. The implementation itself is a direct Arc clone/as_deref substitution, and no defect was found there. A future coherent-source integration can additionally use Weak<SourceBundle> to make the transitive source-release invariant observable; the current packet field types already exclude that retention path.

Earlier orphan import and deleted-helper doc reference corrections were observed as applied. The original seven tests remain uncompiled/unexecuted by this reviewer. The separate resource cross-thread preexisting-terminal objection remains unchanged.

## Inspected SHA256

- `rust/processing/src/element/presentation.rs`: `8d5acce8dfc9c489be0684af75f5b4dcd2306e977b344f96d9509819835221cf`
- `rust/processing/src/element/model_context.rs`: `5228555bf80a924d739246cc1c47610c63298a193bee35cb30d14e6e375b0cf5`
- `rust/processing/src/element/presentation_palette_tests.rs`: `27b2bc8f3fc3e74af26bfb0c96c201701fcfe8eb53fda1540b914000ae5b4d8b`
- `rust/processing/src/element/assembly_job.rs`: `06b3fa9eebe0fb0d07a2138ec71d0a15c487abb12055cf89149fd5765715f971`
