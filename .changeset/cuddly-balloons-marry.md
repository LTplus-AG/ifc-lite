---
"@ifc-lite/server-client": major
"@ifc-lite/viewer": patch
---

Allow cancellation of cached data polling and distinguish missing or pending entries from HTTP, transport, and decode failures.

Breaking: fetchDataModel now rejects HTTP failures and exhausted transport failures instead of resolving to null. Catch these failures when properties are optional; null now means only a missing or still-pending cache entry. fetchSymbolic follows the same contract.

Viewer completion, model finalization, and load telemetry now wait for optional property fetching and decoding. The default property poll may spend roughly 5.3 minutes in bounded request timeouts and backoff, and is cancellable. Cancelling or superseding that wait no longer falls through into local WASM processing.
