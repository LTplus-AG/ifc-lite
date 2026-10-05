---
"@ifc-lite/opencde-foundation": minor
"@ifc-lite/bcf-api": minor
---

OpenCDE requests accept an `AbortSignal`, a `timeoutMs` limit and extra headers (#6896): `FoundationRequestOptions` and `HttpRequestOptions` gain `signal`, `timeoutMs` and (for the former) `headers`, and an already-aborted signal is refused before `fetch` is called. `BcfApiClient`'s read and write methods take an optional trailing `BcfRequestOptions`. A request rejected after dispatch still has an unknown server outcome; callers must reconcile before resending a write. New `topicToApiWrite` and `viewpointToApi` map `@ifc-lite/bcf` topics and viewpoints to BCF API request bodies (client-owned fields only; `default_visibility` is always written because BCF API defaults it to `false`).
