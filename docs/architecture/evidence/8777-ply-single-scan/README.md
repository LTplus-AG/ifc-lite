<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# A large PLY is scanned once, and Cancel stops `open()` (#8777)

A PLY's `open()` scans the whole body for bounds. `streamPointCloud` opens a
stride-1 probe. When it then downsamples or picks a local origin (the viewer
always passes `autoOrigin: true`), it used to close the probe and open a fresh
source, which scanned the body again. It now calls the source's optional
`reopen()`, and `PlyStreamingSource` keeps its first scan. Separately, the
worker client now forwards an abort while `open()` is still pending, so a
cancel stops the scan at its next 4 MiB window.

Fixture: the synthetic 300,000,000-point binary PLY (4.50 GB) from
[`../8773-large-point-clouds/generate.mjs`](../8773-large-point-clouds/generate.mjs).
"main" is `origin/main` at the branch point; "branch" is this change.

## Through `streamPointCloud`, in process

[`host-run.mts`](host-run.mts) streams the file with the real
`PlyStreamingSource`, the viewer's options (`autoOrigin`, default 25M cap) and
an fs-backed `Blob` that counts every byte read. Two interleaved runs each:

| | Bytes read | Reads | `onOpen` after | Total | Emitted | FNV-1a of positions + colours |
| --- | --- | --- | --- | --- | --- | --- |
| main | 13.72 GB (3.05 × file) | 3,273 | 56.2 s, 58.4 s | 63.3 s, 65.6 s | 25,000,000 at stride 12 | `60240c1c` |
| branch | 9.22 GB (2.05 × file) | 2,199 | 29.2 s, 29.6 s | 37.7 s, 36.8 s | 25,000,000 at stride 12 | `60240c1c` |

The output is byte-identical, and so is the reported bbox. The remaining
0.05 × comes from the decoder re-reading one window at each chunk boundary,
which this PR does not change.

## In the viewer

Production viewer builds (`vite build`, served by `vite preview`) of main and
branch ran in Windows Chrome on a real GPU, with a fresh profile per sample,
driven over CDP by [`browser-run.mjs`](browser-run.mjs). The file goes in
through the viewer's own file input with `DOM.setFileInputFiles`.

**Cancel during `open()`.** The script clicks the status bar's Cancel while the
bounds scan runs, then counts the decode worker's `Blob` reads. The button hides
at once in both builds; the reads show whether the worker actually stopped.

| Cancel at | | Worker reads after Cancel | Last read after Cancel |
| --- | --- | --- | --- |
| 4 s | main | 985 (≈ 4.1 GB) | 46.8 s |
| 4 s | branch | 0 | none |
| 8 s | main | 804 (≈ 3.4 GB) | 24.9 s |
| 8 s | branch | 0 | none |

**Full load**, run in the order main, branch, main, branch: main took 119.0 s
and 74.5 s, branch 62.8 s and 42.1 s. Absolute browser times drift between runs
on this machine, so the in-process byte counts above are the deterministic
measure.

## Reproduce

```sh
node docs/architecture/evidence/8773-large-point-clouds/generate.mjs ply /tmp/big.ply 300000000
pnpm exec tsx docs/architecture/evidence/8777-ply-single-scan/host-run.mts packages/pointcloud/src /tmp/big.ply
# main: git archive origin/main packages/pointcloud/src | tar -x -C /tmp/main
#       then pass /tmp/main/packages/pointcloud/src
node docs/architecture/evidence/8777-ply-single-scan/browser-run.mjs <cdpPort> <viewerUrl> 'C:\path\big.ply' cancel 4
node docs/architecture/evidence/8777-ply-single-scan/browser-run.mjs <cdpPort> <viewerUrl> 'C:\path\big.ply' load
```
