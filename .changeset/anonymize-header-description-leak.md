---
'@ifc-lite/export': patch
---

`exportAnonymizedSubset` blanks the STEP header's `author`/`organization`/`authorization` fields outright, but left `FILE_DESCRIPTION` unset — which falls through to `buildStepHeader`'s own default of carrying the SOURCE file's description items verbatim when no explicit value is given. An authoring tool's free-text `Comment [...]` item there (a project or client name, a contact address) survived every anonymized export unscrubbed, alongside the header fields right next to it that were already blanked. `description` is now blanked the same unconditional way as the other header identity fields.
