---
"@ifc-lite/bcf": patch
---

`writeBCF` no longer adds explicit directory entries (`<topic guid>/`) to the archive. That entry was the one structural difference between an export Solibri refused and the same topic re-exported by BIMcollab, which Solibri opened (#3612); every file path already carries its folder, and the BCF spec never asks for directory entries.
