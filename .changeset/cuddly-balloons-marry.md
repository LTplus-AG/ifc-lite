---
"@ifc-lite/server-client": major
"@ifc-lite/viewer": patch
---

Allow cancellation of cached data polling and distinguish missing or pending entries from HTTP, transport, and decode failures.

Breaking: fetchDataModel now rejects HTTP failures and exhausted transport failures instead of resolving to null. Catch these failures when properties are optional; null now means only a missing or still-pending cache entry. fetchSymbolic follows the same contract.

Viewer geometry completes, finalizes and emits load telemetry without waiting for optional properties. Property fetching runs under the loaded model's lifetime, independently of the load attempt's metadata signal; model removal/replacement, supersession and hook unmount abort it. Late responses cannot overwrite another model. Stale server attempts still never fall through to local WASM processing.
