# Python rebar preflight: finite comparison regression (#6305)

The preflight JSON validator rejects non-finite `measured_m` and `limit_m`
values before serialization. The sibling `rebar_schedule_tests.rs` test builds a
schedule from the committed U-bar IFC fixture and injects Infinity and NaN into
those fields. The Rust unit test is in `rust/python`, a PyO3 crate excluded from
the root Cargo workspace, so the root changed-tests revert oracle cannot route
it to an owning Cargo package.

From a clean checkout at this PR head, the normal check is:

```sh
cargo test --manifest-path rust/python/Cargo.toml --lib
```

The included patch is intentionally oriented from the faulty behavior to the
shipped behavior. Reverse-applying it removes only the new preflight comparison
checks while leaving imports and the test registered:

```sh
git apply --reverse docs/architecture/evidence/rebar-preflight-6305/nonfinite-comparison-mutation.patch
cargo test --manifest-path rust/python/Cargo.toml issue_6305_preflight_comparisons_cannot_become_null -- --nocapture
git apply docs/architecture/evidence/rebar-preflight-6305/nonfinite-comparison-mutation.patch
```

On the reviewed branch, all three unit tests pass normally. With the mutation,
the regression test executes and fails at an assertion (`unwrap_err()` receives
`Ok(())`); after restoration it passes again and the worktree is clean. The
patch is evidence only and is never applied in a build or release.
