---
"@ifc-lite/server-bin": patch
---

Fail closed when no SHA-256 checksum is available for a downloaded server binary. The release pipeline now publishes an `<archive>.sha256` sidecar next to every archive, so a missing or unfetchable checksum means the download cannot be verified and is refused instead of executed behind a warning (previously the fail-open branch was the only one that ever ran, because no sidecar was ever published). Releases without sidecars are only ever downloaded by older package versions, which keep their shipped behaviour.
