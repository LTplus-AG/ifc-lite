# Combined viewer qualification plan (not run yet)

## Immutable source pin

- Base: `c53cfaa3a2034638f4c4ab40f7674b29e0528fed` (tree `9287fa44578221cfbc091d14ba7925bba42a8d8b`).
- Candidate tree: `323c7c47be86076c438da04d3a7c0f28b4b32b02`.
- Candidate patch SHA256: `5f750906d0f6b2a56396b7387a4117a2850f6f4f1747c3d3338ba4dd82e67e96`.
- Exactly five changed paths: the three reviewed 7910 class-literal files and the two source/test files from 7901. The candidate worktree is separate and detached; the original 4d7 worktree and branch remain clean and unchanged.

## Artifact reuse decision

The prior PC 7901 job is **not** a valid Rust/WASM reuse source for c53. Its source commit `5da6bb4d147ba520a807ac7e3a57a23fa712264f` differs from c53 in 50 Rust paths, and its package WASM hash is `b22f4d38...`. Its target `7548ffe...` is left read-only and will not be copied.

A source-compatible c53 root Turbo cache entry is available from the retained c53 base build. Its `@ifc-lite/wasm#build` task hash is `90c398373844d98e`, cache metadata pins source SHA `c53cfaa3...`, and its cached tar contains the generated runtime/bindings with the same hashes as the retained exact-c53 build output (WASM `ddce7a28...`, JS `04c85b14...`, d.ts `e2bf5dee...`). A root Turbo dry-run against both c53 and the combined candidate reported this task as a local HIT. The three cache files are copied into this qualification's artifact directory, hash-pinned, then embedded in a temporary private Git ancestor so the fleet worker can materialize them only into its own admitted Turbo cache. No shared cache or target will be modified.

No source-compatible prior **PC** c53 runtime/cache was present in PC receipts. The c53 artifact above is the available exact-source cache; the worker script refuses before building if the real root Turbo graph does not report the pinned WASM task as a HIT. This prevents a Rust/WASM rebuild. PC's old 7901 target is not used.

## One finite PC ordinary job

Use an invocation-only fleet config containing only the already-enabled `pc-wsl` host. Do not alter global fleet policy. Request 2 CPU / 12 GiB and let fleet allocate a private checkout and target. The driver checks, inside admission, that checkout, target, and target parent each have over 60 GiB free and over 1,000,000 free inodes. It records worker versions and source pins. Three lean Cargo settings are zeroed; Node heap is 6 GiB; Turbo concurrency is one to fit the ordinary PC allocation.

Within the one locked checkout and one private Turbo cache:

1. Install dependencies once with `pnpm install --frozen-lockfile --prefer-offline` if needed.
2. Check c53 and candidate WASM-task cache hits, then run the ordinary root production viewer Turbo graph on c53 and measure entry/eager/CSS/WASM assets plus existing ratchets.
3. Switch to the exact five-path candidate tree, verify the same WASM cache hit, run the same root production build and measurement.
4. On the candidate only, run the root Turbo focused `storey-live-frame.test.ts` viewer regression; run root filtered viewer Turbo typecheck and `pnpm run typecheck:tail`.
5. Record both measured arms, all asset hashes, existing ceilings/gate results, test/typecheck exits, clean source/ref pins, and output hashes. No browser/timing benchmark or new threshold is involved.

The prepared driver is `qualify-combined.sh`; `bash -n` passes. It does no publication, remote branch push, changeset, PR, merge, or ruleset work. The candidate remains unqualified until the actual admitted run completes and is reviewed by the parent.
