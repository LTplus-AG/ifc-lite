---
"@ifc-lite/server-bin": patch
---

Fall back to the newest older GitHub release that carries this platform's binary when the package version's own `v<version>` release is missing (#5525). `npx @ifc-lite/server-bin` 404'd on every platform for 1.20.0 and 1.21.0 because those versions reached npm without a matching release. The fallback is found through the GitHub releases API, only considers releases that also publish a checksum, is SHA-256 verified like the primary download, and prints a warning naming both the requested and the used version. It only triggers on a 404, never on a network or server error. When no fallback is available, the error now says how to pin a version that has binaries instead of recommending the Docker template.
