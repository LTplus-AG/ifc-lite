# Native held-FD control evidence — #6537

This packet qualifies local independent ELF/kernel FD selection and the controller
seams. It does **not** qualify canonical IFC-command compatibility, hosted native
phase timings, browser worker-pool performance, full appearance or a speedup.
Measured local launcher source:
`5e1735b43bdff16fab601a5cb4ff6aa7d81ff5eda8fcb9776d390319a8adbca0`.
The source layer starts from controller `59736eab701d20cccaf070ed09668552427b1d1f`.

The immutable predecessor hosted run
[37175610695](https://github.com/LTplus-AG/ifc-lite/actions/runs/37175610695)
correctly refused a target query that exited before live-file pinning, before
subject builds and with zero pairs. Its complete raw packet remains separately
retained; this packet preserves its reference, not a relabelled success.

Retained chronology:

- The first combined run registered 49 controls: old 48 passed, while the FD
  setup failed before ELF invocation on two real empty imported Python modules.
- A general-empty correction produced 49 passes; it is retained as an intermediate
  source, superseded by strict nonempty defaults with only closure/tool reads
  opting into empty files and still hashing their exact bytes.
- The final registered FD control passes. Neither its assertions nor test source
  changed. The old 48 were not repeated after the narrower callsite correction.
- Numeric-FD-to-path execution actually ran the replacement ELF and caused its
  marker/inode assertion to fail. The digest-only bypass actually accepted wrong
  SHA metadata and caused the invalid-receipt assertion to fail. Both are genuine
  runtime assertions, without module/load errors; exact restoration passes.
- One dedicated normal-250ms startup passes. The ELF itself reports held inode
  `2128:20477502`, PID `59454` and exact argv, matching the held intent and initial
  PID/start/group/parent/source-cwd. Exit, cleanup, both drains, all six strict
  quiet intervals and final file hashes pass; owned temporary files are removed.
  The optional native executable census is empty and is not claimed as proof.
- The independent root review retains 35 raw startup checks. Syntax, scoped lint
  (7 files/136 rules, no warnings), module size, wiring, license and diff pass.
  The missing-TypeScript source-text prerequisite refusal is retained; the gate
  then passes through the explicitly authorized AST-only gitignored dependency
  symlink, without install, package typecheck or sibling `dist` consumption.

`manifest.json` lists all 98 members, their byte counts, hashes and original
paths. The deterministic gzip uses mtime zero and contains 557,499 original
bytes in 160,359 stored bytes. No IFC, executable, WASM, package or library payload
is archived. Historical source snapshots and mutation source are data only.
`index.json` records scope and qualification attribution.

The reused reader is byte-identical to the prior approved reader:
`7a97a8ea20c873416e5d9553afe3119c22b87c053fd5b0cb155063a934530ce2`.
It validates bounded gzip/TAR sizes, safe regular-file names, complete membership
and every stored/original hash before writing into a new destination. It executes
no archived code:

```sh
python3 -I -S -B scripts/perf/evidence/native-prebuilt-fd-6537/safe-extract.py /tmp/native-fd-evidence-fresh
```

Holding an FD prevents pathname substitution, not concurrent modification of its
inode's bytes. Pre-exec intent alone does not establish successful execution.
The production cohort still requires canonical output and exit, frozen sources,
runtime files, library/environment bindings, strict resources and cleanup.
Cargo registry/build-script/linker and whole-machine closure remain incomplete;
the original native FNV excludes appearance channels. Subject builds and the
new hosted protocol remain unrun.
