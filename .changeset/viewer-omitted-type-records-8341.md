---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

The streaming geometry `complete` event gains an optional `omittedTypeRecords` count: the type records whose type geometry the prepass left out because they could not be decoded. It is read from the WASM instance that ran the prepass (on the prepass worker it travels on the prepass `complete` event) and is absent, not 0, when the WASM build cannot report it. The viewer tells the user in a load notice and in the Load report, for example "3 type definitions could not be read, so their type geometry was left out", and shows nothing when the count is 0 or unknown.
