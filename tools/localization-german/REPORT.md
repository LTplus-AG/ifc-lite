> Historical checkpoint evidence. See RELEASE.md for integration scope and pending gates.

# German viewer — implemented; final aggregate gates externally blocked

German is selectable through Settings → General → Language, remembered preference and
browser negotiation (`de-CH` → `de`). No replacement framework or new settings UI.
The shipping entry composes 158 bounded feature modules; the largest is 377 lines.

**Coverage: 10,607 / 10,607 English keys, including lazy keys; 0 missing,
0 unknown, 0 fresh-start validator problems.** See `coverage.json`. 468 exact
English/German matches are explicitly value-pinned with reasons: technical names,
schema syntax, units, placeholders and same-spelling German terminology. Sole
intentional empty message: dimensionless `modelingCommand.unit.count` suffix.

Five improvement rounds, within the maximum eight: implementation; independent
semantic repairs; lazy startup/maintenance repairs; stable test typing; observed
validation-library grammar. `ROUNDS.md` records actual findings and changes.
The glossary and update instructions are in `apps/viewer/src/i18n/README.md`.

Translation roles: Claude Opus 5.5 high (one feature shard), Codex gpt-6.1-sol high
(two shards). Independent semantic reviewer: gpt-6-astra high. Independent
coverage/exception reviewer: gpt-6.1-sol high. Browser tester: gpt-6.1-sol high,
followed by coordinator rerun after repairs. These are LLM reviews and actual
runtime checks, not native-speaker approval or a statistical/performance claim.

## Passed evidence

- Root `pnpm test --filter=@ifc-lite/viewer` through Turbo, final selector covering
  i18n and validation-panel localization: **62 passed, 0 failed, 0 skipped**,
  14 selected files; 59/59 Turbo tasks successful. Includes all-key and placeholder
  validation, non-count context in both plural forms, real catalogue negotiation,
  persistence, German Intl numbers/dates/input and isolated lazy-startup ownership.
  Original initial run: 57/57; final test/build receipt on Pop:
  `eeead94c-ca5a-4f4f-beac-73e2097a6385`. Selector forwarding: `test-plan.json`.
- Clean committed root `pnpm typecheck` on PC, commit `1e6686888e`: all 134 Turbo
  tasks and root tail passed, 4,479 test files audited. Subsequent production
  change was four German string corrections, exercised by the final root tests.
  Receipt `2364bfa8-6616-4164-909b-912b720dc6b1`; its later, over-broad pre-handoff
  phase was stopped (details below); do not describe the whole combined job as green.
- **10/10 real-model GPU workflow checks, exit 0, no page errors** on Pop hardware
  Intel Gen-12LP, not SwiftShader. Real npm WASM 12.2.0 fetched and rendered.
  Actual committed house: 14 meshes / 12 geometry elements. Hierarchy/Geschoss,
  actual selection/properties, measurement drag, section plane, German IDS
  findings and parsed JSON download, 1600×1000 / 390×844 layouts, accessible names,
  persistence/reload, English switch and fresh browser negotiation all exercised.
  Final run also asserts the four corrected library controls. `WORKFLOW.md`
  gives exact commands, hashes and screenshot names. Final runtime source:
  `aea79e9a1ca63c8e3aed03fa2a57ea2dde7bbed8`.
- The actual final default viewer bundle passes retained-free validation:
  1,022 files checked. Its admitted preview service was stopped after acceptance.
- Direct lightweight global gates passed: source-text assertions, test wiring,
  test teardown order, module size, i18n JSX literal ratchet, test-glob coverage,
  CI path/aggregate coverage and diff whitespace. Final admitted aggregate gates
  are recorded below when their original request finishes.

## Final aggregate gates

Queued original fleet request `auto-0fce1bb98b224ca5af396a9d93a374d4`, code source
`aea79e9a1c`, PC worker `aea9d9a8-a2a7-456f-b78b-85518047b1f7`:
`pnpm install --frozen-lockfile`; `node scripts/pre-handoff.mjs --base f6ffa4fc655d6ec29c3c8f0baaaacde76bb4899f`; `pnpm lint`.
The explicit base is the actual task start commit, avoiding stale worker refs.
Actual admission blocker (original worker status): `resource_conflict`, foreign job
`5f489f02-21e9-4d2c-8375-c62789e72f88`, resource
`/home/louistrue/build-workers/worker-state/caches/fa5520234504608b1cf6af3d`.
That original long-running job, its lock and the queued final request are preserved;
no bypass, reroute or duplicate submission. Final Pre-Handoff and root lint are
**not claimed as passed**. The source checkout remains available for the original
request. This is the remaining external blocker, not an unresolved German defect.

The mandated root Pre-Handoff invocation after commits also ran and failed its
clean-tree preflight because the protected campaigns remain untracked. The clean
fleet request is the intended aggregate run. Compact completion documentation is
committed separately from the code checkpoint; it changes no production/test code.

## Failures, skips and boundaries (not hidden passes)

- Initial package filter `viewer` was obsolete; corrected to `@ifc-lite/viewer`.
  Early build during translation failed on not-yet-written feature imports.
  Both were superseded by successful final production builds through root Turbo.
- First clean fleet command lacked `pnpm install`; `turbo` was absent (request
  `auto-766fa5bc2fb847928c972ed61b831d30`, worker `6f8f7006-9de9-41d4-a6a7-e0ffc2dd4298`).
  Receipt inspected before submitting the corrected command.
- Stable PC validation of `866a6fd726` caught new test typing errors missed by the
  earlier local run while tests were being added. Fixed in round 4; clean root
  typecheck subsequently passed. Original failed request:
  `auto-66a81bb063ce47feaf71b1a6a4977456`, worker `df5994ae-c487-4a52-87b9-0f06fa520864`.
- The clean `1e6686888e` request passed typecheck and global pre-handoff gates,
  but its default stale `origin/main` compared 1,917 paths and launched unrelated
  historical mutation oracles. That superseded phase was deliberately stopped;
  original receipt says source unchanged. The final scoped request is above.
- A direct Unused-Locals run was stopped after discovering its heavy compiler
  graph; no verdict/baseline update accepted. Final root lint is admitted.
- Original dirty-tree license scan found an existing missing header in protected
  campaign-v2 `diagnostic-packs.test.mjs`. Protected files were not edited.
  The clean committed scan reported 0 missing headers across 15,398 checked files.
- Clean typecheck-only checkout lacks viewer dist: its retained-free pre-handoff
  step can be SKIPPED; the actual final root-built bundle was separately checked.
- Dependency build skipped its IFCX hello-wall verifier for four absent external
  IFCX fixtures. German workflow used committed IFC/IDS and real WASM, with no skip.
- Initial preview 404 and GPU-device failures are preserved; no blank screenshot
  counts as success. Explicit Intel ICD + provisioned Chrome 154 completed the
  final run. No full Rust suite or full monorepo/viewer suite was claimed.
- Legacy uncatalogued text remains outside catalogue coverage: theme toggle
  `Toggle dark mode`, ViewCube face names, chart source choices, some runtime
  toasts, extension/template/tour content. Narrow layout is sampled, not an
  exhaustive a11y/overlap audit; the privacy notice occupies lower viewport space.

No known major catalogue meaning defect remains from the reviewed workflows.
Both old campaign trees remain byte-identical: 8,965 files; compact hash evidence
in `preservation.json`. Never staged. No push, PR or merge.
