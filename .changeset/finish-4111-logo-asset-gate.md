---
"@ifc-lite/viewer": patch
---

Delete four more unreferenced favicon originals under `apps/viewer/public` left over from the same cleanup as #4111/#4114, and losslessly recompress `logo.png` (pixel-identical, verified) from 1.39 MB to 1.26 MB. `apps/landing/assets/logo.png` and `docs/assets/logo.png` — byte-identical copies of the same logo, each required by a genuinely separate deployment (the standalone landing site and the mkdocs docs build) — are recompressed the same way for consistency, though neither ships as part of the viewer bundle.

Also widen the new asset-usage gate's `TEXT_EXTENSIONS` to include `.mts`/`.cts`: `tools/demo-kit/derive-variants.mts` builds `apps/viewer/public/samples/*` paths, and until now the gate's text scan skipped that file, so removing the one other (redundant) mention of a sample name would have made the gate call a live asset dead.
