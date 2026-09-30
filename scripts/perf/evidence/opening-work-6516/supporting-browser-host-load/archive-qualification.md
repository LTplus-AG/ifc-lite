# Supporting measurement archive qualification (#6516)

This archive-only split adds captures, not executable code or a new performance claim.
The corrected geometry comparisons, qualification, all 100 timing observations and
three surgical regression oracles remain in merged [#6536](https://github.com/LTplus-AG/ifc-lite/pull/6536).

The supporting measurements were restacked onto actual merge `526a91bdf33e2be2d6167df95a68db343b5337c0`.
Their complete two-part evidence tree is byte-identical before and after that restack:

```sh
git diff --exit-code 961c303 bc7f960 -- scripts/perf/evidence/opening-work-6516
```

The first part at `fe049d9` contains 18 JSON/JSONL captures and their README.
The executable test-observation gate classifies those captures as production,
then aborts because no test changed. This is an applicability failure, not an
observed regression test. The existing maintainer `revert-oracle-exempt` label
applies to this evidence-only PR; it changes no workflow, classifier or runtime guard.

Both archive PRs still require final-head source CI, independent diff review
and resolved feedback before merge. A later executable change needs its own
behavioral qualification; these captures do not exempt it.
