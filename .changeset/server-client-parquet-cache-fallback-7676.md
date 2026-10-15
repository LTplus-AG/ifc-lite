---
'@ifc-lite/server-client': major
---

`parseParquet()` now uploads the file when `/cache/geometry` answers `404` for an entry `/cache/check` just reported. A damaged cache entry passes the check, fails the fetch, and is dropped by the server; this call used to fail with `NOT_FOUND` and only the next one healed it. The bump level is the one the other #7676 changeset already sets for this package.
