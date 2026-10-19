# Owned terminal C4 test executable archival

Completed0, original maintenance session **24954**. Stopped immediately after completed batch22 reached actual free space **354,416,574,464 bytes (330.076 GiB)**, above the330 GiB goal. Current free after index assembly **353,514,246,144 bytes (329.236 GiB)**. No further batch was started.

**1,403 old test executables were relocated into22 durable standard PAX tar/zstd archives. Their original paths are absent and their inodes were released.** No assertion that all paths/inodes remain unchanged. Original logical bytes **175,566,628,368**; original allocated bytes **175,529,119,744**; compressed archive bytes **38,091,025,338**; archive allocated bytes **38,091,165,696**; net allocated recovery **137,437,954,048 (127.999 GiB)**. Filesystem free-space delta also includes concurrent writes; it is not substituted for allocated recovery.

Only regular, single-link, positively fingerprinted Cargo test-lib/test-bin/test-integration-test executables under authorized debug/deps roots were eligible. All358 eligible r2 tests and1000 r4 tests, plus45 r3 tests, were archived; remaining **312** eligible old tests stayed in place once the goal was met. Source/fixture/log/receipt/runtime/shared-library/wheel/WASM/generated-consumer outputs, profiling/example producers, foreign targets and any in-place pins were excluded. Explicit pins, exact live references, active jobs/processes and owned target resource locks were checked before mutation. Multiple-link files were not selected.

Every batch retained originals until: archive file fsync and directory fsync; zstd integrity EXIT0; actual standard tar listing EXIT0 with exact expected member list; **every full member SHA256** matched the accepted V23 full-content identity, rebound to unchanged original inode/size/mode/uid/gid/link/mtime/ctime; and every tar member's mode/uid/gid/size/PAX nanosecond mtime matched. Final archive name and complete original/member mapping were fsynced before any unlink; deletion directory was fsynced afterward. All22 archive/member verifications passed. No stripping or executable code execution. Compression/verification inherited actual CPU affinity[0, 1] (max2), nice/idle-I/O priority; no workload/benchmark admission or job was created.

**Restoration:** `RESTORE.md` contains standard GNU tar instructions with no-overwrite semantics. `archive-index.json` contains literal per-archive restore argv and manifest references; `relocation-map.jsonl` maps every original absolute path to its archive/member/hash/mode/uid/gid/exact mtime (decimal string). Archives are required evidence, not disposable compiler caches. Restored files acquire new inodes/ctimes; no inode restoration is promised. No restoration/build/test/benchmark was executed.

All **37,008 unmoved prior retained paths** match accepted V23 inode/size/mode/owner/link/mtime/ctime identities. Original V23 authority hashes match its accepted manifest (`accepted-v23-authority-verification.json`). Exact r2/r3/r4 source heads/trees/clean status and182 fixture size/SHA checks per source before/after match; all **55** linked original logs/receipts/declared-evidence SHA identities match; maintenance tool/config bytes unchanged. Profiling/example producer outputs and currently consumable artifacts stay in place. Historic provenance remains immutable and is explicitly supplemented by the relocation map.

Original session terminal0 collected; original controller PID/start token gone; no owned archive/compressor processes remain. Existing target resource locks are released. No global guard/reserve/resume/scratch configuration change, foreign cleanup, source/ref/publication action, automatic benchmark dispatch/queue or performance/C4 acceptance. Parent owns any subsequent fresh admission decision and timing.

| Archive ID | Executables | Compressed bytes | SHA256 |
| --- | ---: | ---: | --- |
| b001-3a9c872d829495e0751f | 44 | 1776156825 | `2e3722a9e72ae64631284c9ebdd0c4a7f7ed4be29f09f92da3f2d99fd46db1e3` |
| b002-3a9c872d829495e0751f | 51 | 1854154907 | `20a7377d19727477f8c7657cec270a57f5033f40d9c7dd434dedcc26b185092d` |
| b003-3a9c872d829495e0751f | 54 | 1788623265 | `a280b49f05884b4b48be10acafcc35011bf80e178ba8ff7c11edd1d70044ec2c` |
| b004-3a9c872d829495e0751f | 74 | 1902063072 | `45692f17ad1969233d44b5268b4ad81c88b168a239731ec5296ad20375c78b4e` |
| b005-3a9c872d829495e0751f | 79 | 1910092171 | `ad4dac74c637b7498f9445fde9eadaa44e519f71d126b67eb02d2e6f35cb8f87` |
| b006-3a9c872d829495e0751f | 56 | 615385837 | `a1d2afc59b19393ab8ace315c9d399b2e1124c670f6d84570511fc9e432ab107` |
| b007-49926200a29e09a7679b | 23 | 1506447721 | `1ca8ee5913c252af611d16032d41b3130ae033dcf7929d41e6204d6de74dcb79` |
| b008-49926200a29e09a7679b | 35 | 1697371955 | `9cb3af5f72b61611eeb219d76750f836d995312b7f0929a9a4d4be9e24e26ade` |
| b009-49926200a29e09a7679b | 50 | 1822352471 | `96a320c93ca84cc1c49693ca210a4696447150e25472a186d0e680a32a2ed403` |
| b010-49926200a29e09a7679b | 52 | 1836295500 | `785445b35ac8f81d2887dfe6f84d8a53e88efa689094c235e0cf1fd182f5d1bf` |
| b011-49926200a29e09a7679b | 64 | 1812423837 | `09f45cd425b7dbc56ba631979c5421f6d693a3f1790d3beeecdea129c527952e` |
| b012-49926200a29e09a7679b | 77 | 1968319989 | `4013f2bd3a0c72a9a26b10afdd4cf55c5ef463add9960740ffd6d88d9263108e` |
| b013-49926200a29e09a7679b | 78 | 1961575238 | `ca85c59597b99f8543cef829a11bf1e6258d60beb2424f431863b58156ec8811` |
| b014-49926200a29e09a7679b | 78 | 1946427958 | `206a5c3e97a7eee3f8e7c95adadbbbfcffbe9c910b0f0b7d0ce891e49f97cd69` |
| b015-49926200a29e09a7679b | 78 | 1930079064 | `d6b8b6ea1d0e7cccfa7c9e413726d066c23c9e0418557fe5cea0a1d0daa24709` |
| b016-49926200a29e09a7679b | 79 | 1933919476 | `0133e6c366639fd01768bc290a58d73e29071591f32aae5b489071919e9dadf7` |
| b017-49926200a29e09a7679b | 79 | 1925034744 | `5f1293f890d65c1fa489c3cb0d2d3c4af723dc46b30f8372afeceae018d91b38` |
| b018-49926200a29e09a7679b | 79 | 1907915267 | `345993caae915c3d14312068c8696f77a1db6308e4378594929861381296600c` |
| b019-49926200a29e09a7679b | 83 | 1828962281 | `99b6b93f365d69233712e46aba4c2d98f8343015f3071f06885f73eec1e2ce8d` |
| b020-49926200a29e09a7679b | 85 | 1838779844 | `f0050ec5aff1ec1ea8cf7547da171e7629b51530a4c3c2ee07b3d5d1dd5611b8` |
| b021-49926200a29e09a7679b | 60 | 526365866 | `b30fbd8166aff77dcc2707c61966c69fecd05d4ef390479e2b2db82ed0a22834` |
| b022-899d43786f3f1d14e1ff | 45 | 1802278050 | `e8cfac556f37295f8a44c97b43abf7d6a20734f89e03fb630b8107e560dbcc18` |
