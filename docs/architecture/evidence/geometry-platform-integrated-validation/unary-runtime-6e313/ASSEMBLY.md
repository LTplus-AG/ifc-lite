# Parallel fault fixture setup repair

Frozen source commit: `6e313d755f2e0c032e31a81b663c59753fdf85d1`.
Reviewed immutable checkpoint: `f95d10b96b9e5096bd232dda205ae2eac2c69eb7`.
Combined base: `c05004953082dad0fc3213940d44f9a4456d3f6c`.

Independent f95 closure confirmed production unknown-status retirement, then
identified a parallel witness setup collision: two tests can create the same
PID+status7 directory. Fixture::new now appends a process-wide AtomicU64 suffix,
allocated with relaxed ordering. Each call in the process receives its own
suffix, including concurrent calls with the same case. Fixture::drop and all
actual fault cases/assertions are unchanged. No production/numerical changes.

Verify SHA256SUMS and choose one patch:

- `after-f95.increment.patch.gz`: exact f95-to-6e313d increment; changes only
  `rust/geometry-runtime/tests/plane_faults.rs`.
- `combined-owned-from-c050.patch.gz`: updated combined runtime increment for
  the parent, which has not integrated the child yet. Includes the original
  bridge, native unknown-status repair and this setup fix; excludes delivery
  artifacts. Apply this instead of earlier combined patches or increments.

```sh
gzip -dc /absolute/path/to/CHOSEN.patch.gz | git apply --3way -
```

Both patches carry full Git blob identities and were reverse-checked against
the frozen source checkout. source-manifest.json records exact before/after
SHA256 hashes. Preserve independent parent edits, including Boolean/cleanup
ordering; never overlay complete shared files. Original a1bc/f95 commits and
both earlier delivery directories remain immutable.

Rustfmt syntax parsing and diff/patch checks pass. Rust compilation, fault-test
execution, Clippy and actual SDK/browser qualification remain unrun here.
All prior numerical and product-preservation residuals remain open. No heavy
jobs, queue/lock changes, common/P2/browser/C++ edits, generated bindings, push
or PR. Root must execute the actual witnesses after assembly and admission.
