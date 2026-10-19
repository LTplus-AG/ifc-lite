# Final disk cleanup — 2026-10-19

Removed 330.94 GiB of audited disposable build/cache allocations across Pop and PC, plus additional Windows package caches and redundant source copies. The allocation total excludes those extra Windows directories/source copies and excludes WSL trimming to avoid double counting. Filesystem free space also changes with unrelated jobs.

Pop: 191.89 GiB. PC: 139.04 GiB. Online WSL trim discarded 123.9 GiB of already-free blocks. PC Linux available space increased from about 53 MiB to 132 GiB; Windows reported 784 GiB available at final observation.

Rebuildable Cargo deps/incremental/build/fingerprint outputs and private inactive package caches were removed. This supersedes the original retirement relocation map for those explicitly listed compiler-cache paths. Source bundles and their exact refs/commits, authored patches, original reports/logs, raw output witnesses, fixtures, benchmark executables and explicitly retained binary archives remain preserved. Recreate removed build caches from pinned source; do not represent a rebuild as a new qualification without running the required gates.

All seven complete PC source checkouts were clean and their heads verified reachable from retained source/child/supplemental bundles before removal. One old failed partial checkout and its source mirror were also retired. See pc-source-bundle-coverage.json and the PC source-copy receipt.

Foreign/shared caches and active jobs were preserved. Own cache-cleanup helpers were stopped after compiler cleanup to switch the remaining Windows cache removal to native Windows operations; no build/test job was restarted. All remaining cache deletions then completed.
