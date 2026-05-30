---
"@ifc-lite/clash": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/viewer": minor
---

Add representation-agnostic clash detection.

`@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
clearance / touch classification) with a pluggable TS reference kernel and a
Rust/WASM kernel kept in lockstep by a differential test. Results group into a
*manageable* set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

Surfaced through the existing tools:

- `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
  runnable rules from any preset list (the discipline matrix is this over the built-ins),
  so hosts can run a user-curated rule set.
- `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
  presets, A/B highlight + camera framing, configurable settings & custom rules, a
  controllable BCF export with optional rendered snapshots).
- `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
- `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
  `--clearance`, `--bcf`.
- `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
  and `clash_matrix`.

The discipline matrix now threads a `clearance` value onto its rules, so
`--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
violations instead of silently dropping the override.
