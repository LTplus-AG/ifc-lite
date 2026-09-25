---
"@ifc-lite/server-bin": patch
---

The release fallback no longer picks a release whose shared `SHA256SUMS` doesn't list this platform's archive. That release would download and then fail checksum verification, which aborted the install even when an older release could have worked. A SHA256SUMS-only release now counts only after its body is seen to list the archive; otherwise the lookup moves on to the next older release.
