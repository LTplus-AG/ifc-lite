---
"@ifc-lite/bcf": patch
---

Fix `readBCF` silently returning an empty project for a `.bcfzip` whose entries use backslash path separators (a real historical Windows-zip-writer output). Topic-folder, viewpoint, and snapshot matching now tolerate `\` as well as `/`, and reading now warns when a `markup.bcf` entry exists that no topic folder can claim, instead of returning a successful empty result with no signal.
