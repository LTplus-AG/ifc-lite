---
'@ifc-lite/cli': minor
'@ifc-lite/mcp': minor
---

Layer store and merge hardening:

- **cli**: `loadLayer` verifies the blake3 content address on every read (a tampered or corrupted layer file fails loudly instead of composing silently); refs.json, layer files, and draft.json are written atomically (temp file + rename); `layer publish --check <spec.ids>=<report.json>` stamps verified check evidence into the provenance manifest — pass/fail derived from the `ifc-lite ids --json` report, spec and report content-addressed; `layer merge` refuses a candidate whose declared base matches nothing on the target ref (exit 5) unless `--allow-unrelated` is passed.
- **mcp**: `diff_layer`, `dry_run_merge`, and `list_conflicts` report `base_resolved` so agents can tell when a preview ran against an empty ancestor (the placeholder `would_fail_checks` field is gone).
