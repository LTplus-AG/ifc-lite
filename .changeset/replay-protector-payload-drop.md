---
"@ifc-lite/collab-server": patch
---

Fix the anti-replay protector silently dropping every update it verified.

`verifyWithReplayProtector` unwraps a signed envelope (tag + clientId + clock + hmac + inner y-protocol frame) down to the inner frame and returns it as `payload`, exactly as documented for wiring into `RoomOptions.verifyMessage`. But `VerifyDecision` never declared a `payload` field, and `Room.handleMessage` always dispatched the raw envelope bytes it received — never the verifier's unwrapped `payload`. The envelope isn't itself a valid sync/awareness frame, so `dispatchMessage`'s outer varint decode fell into its `default: // Unknown frame; ignore` case: every signed, HMAC-verified, non-replayed update was accepted by the verifier and then discarded with no audit entry and no error.

`VerifyDecision` now carries an optional `payload`, and `handleMessage` dispatches it in place of the raw message when a verifier supplies one. Verified end to end: a real signed sync-update frame sent over a live websocket to a room wired with `verifyMessage: verifyWithReplayProtector(...)` now lands in the room's `Y.Doc`, where before the fix it silently vanished.

**Also fixed:** dispatching the unwrapped payload bypassed the role, rate-limit, and payload-size gate. `preCheckWriteFrame` runs on the *envelope*, and a signed envelope's outer byte is never `MESSAGE_SYNC`, so it always took the early `return true` — no role, limiter, or size check. That was harmless while the envelope was silently dropped; after unwrapping it, the real write frame inside reached the doc having passed none of those gates. Confirmed by execution: a `viewer`-role connection sending one correctly-signed envelope had its write land in `room.doc` with zero `reason: 'role'` audit entries. `handleMessage` now re-runs `preCheckWriteFrame` on `decision.payload` before dispatch, so an unwrapped write frame is gated exactly like a plain one. Two regression tests pin the negative cases: a viewer's signed write is rejected with `reason: 'role'` and does not land, and a signed envelope whose inner frame exceeds `MAX_SYNC_PAYLOAD_BYTES` is rejected with `reason: 'sync-size'`.
