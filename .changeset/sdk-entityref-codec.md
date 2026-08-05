---
"@ifc-lite/sdk": patch
---

Fix two decoding bugs in the `EntityRef` string codec.

`stringToEntityRef` accepted a truncated reference: because `Number('')` is `0` — finite and non-negative — `'arch:'` decoded to `{ modelId: 'arch', expressId: 0 }` instead of throwing. A truncated or corrupted persisted reference silently resolved to entity 0 rather than failing where the corruption happened.

It also split on the *first* colon, so a `modelId` containing one did not survive a round trip: `entityRefToString({ modelId: 'proj:arch', expressId: 5 })` emits `'proj:arch:5'` (the encoder does not escape), and decoding that threw, because the id part came out as `'arch:5'`. Encoder and decoder disagreed about their own format.

Decoding now splits on the last colon — `expressId` is always numeric, so it can never contain one, while `modelId` may — and requires the id part to match `/^\d+$/` rather than relying on `Number()` coercion.

No in-repo caller passes a colon-bearing `modelId` today, so this is a latent correctness fix rather than an observed failure. Note that `apps/viewer` carries a second, independent implementation of the same codec with different semantics (it returns a `{ modelId: '', expressId: -1 }` sentinel instead of throwing, and deliberately treats the first colon as the separator); this change does not touch it.
