---
"@ifc-lite/sdk": patch
---

Fix `bim.ids.validate({ locale })` being silently ignored. The SDK forwarded a `locale` key into `@ifc-lite/ids`'s `validateIDS` options, but `ValidatorOptions` has no such field — only a `translator` object it destructures directly — so every call produced English-only messages regardless of the requested locale (this also made the CLI's `ids --locale` flag inert).

`validate()` now builds a `translator` from the requested locale via `createTranslationService` before calling into the validator, the same pattern the viewer's IDS worker already used. `de` and `fr` locales now actually change the human-readable requirement and failure text in the validation report.
