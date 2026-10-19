<!-- SPDX-License-Identifier: MPL-2.0 -->

# Historical Python source preservation

This addendum preserves the exact original bytes of eight Python scripts used by earlier geometry-platform evidence. It does not change or supersede any historical receipt, recorded hash, source manifest, log or measurement. Historical hashes for these paths refer to the original bytes archived here. The scripts at their existing paths are now maintained convenience copies with MPL notices added; they are licensed derivatives of the archived snapshots. Neither the originals nor these convenience copies qualify current production code.

[original-scripts.tar.gz](./original-scripts.tar.gz) contains only the eight original regular files, under their complete repository-relative paths. [original-sha256.txt](./original-sha256.txt) lists each original digest. [preservation.json](./preservation.json) records the archive digest, original and maintained digests, file modes and the exact added notice/byte offset. Original file content was archived before any edit. The only change to each maintained file is insertion of that notice, after its shebang when present. No algorithm, hardcoded historical path or invocation was changed.

The archive has sorted members, original permission modes, zero timestamps and numeric ownership, empty owner/group names, GNU tar encoding, and gzip level9 with empty filename and zero timestamp. Regenerating it independently from its members produced identical archive bytes. [verification.json](./verification.json) records an independent check of all eight archive member digests, each maintained-copy digest, exact restoration by removing only the inserted notice, and Python syntax of both forms. No script was executed and no historical measurement was rerun.

To recover historical bytes without overwriting the maintained copies, run from the repository root:

```sh
preservation_dir="$PWD/docs/architecture/evidence/geometry-platform-python-header-preservation"
restore_dir="$(mktemp -d)"
tar -xzf "$preservation_dir/original-scripts.tar.gz" -C "$restore_dir"
(cd "$restore_dir" && sha256sum --check "$preservation_dir/original-sha256.txt")
```

The restored files remain under their original repository-relative paths inside that temporary directory. Verify the archive digest against `preservation.json` before restoration. Running these historical scripts requires their original inputs, local artifacts and host setup; extraction is preservation, not execution qualification.

After the notice-only edits, the read-only global license check examined13502 files, excluded43, found no unreadable files and reported exactly two remaining malformed current Rust notices: `rust/imported-geometry/src/scene.rs` and `scene_tests.rs`. Those files belong to a separate repair/regeneration task and were not edited here. The check exited1 for those two paths. This addendum does not claim a globally passing license gate.
