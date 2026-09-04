---
'create-ifc-lite': patch
---

The `server` and `server-native` scaffolds pinned `parquet-wasm: ^0.6.0` as an optional dependency, which falls outside `@ifc-lite/server-client`'s narrowed `^0.7.2` peer range. A strict package manager rejects the generated project's install; a permissive one installs a decoder the SDK no longer supports, so the first Parquet decode fails at runtime. Both templates now scaffold `^0.7.2`, and a test asserts the scaffolded pin stays inside the peer range that `packages/server-client/package.json` declares.
