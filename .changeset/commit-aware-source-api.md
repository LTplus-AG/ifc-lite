---
'@ifc-lite/plugin-api': minor
---

Add the commit-aware source API (`PLUGIN_API_VERSION` 2.0.0 → 2.1.0): a provider can now describe models as a chain of immutable commits, and a host can list them, load any commit's payload, read per-element fingerprints and stored diffs without transferring the model file, follow one element's history across re-GUIDs, and create models and commits.

Additive only. Every new member is optional on `FileSourceProvider` and gated by the new `capabilities.commits` object, so the shipped `^2.0.0` providers (Dalux, Dropbox, Microsoft Graph) register and behave exactly as before — asserted in `test/commits.test.ts` rather than assumed.

`SourceIdentity` and `SourceAuth` moved to `src/auth.ts` and are re-exported from `types.ts`, so no import path changes.
