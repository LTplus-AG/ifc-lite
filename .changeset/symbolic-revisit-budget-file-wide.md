---
'@ifc-lite/wasm': patch
'@ifc-lite/server-client': patch
---

Bound the symbolic revisit budget across the whole extraction instead of resetting it per representation item.

A drawing whose repeated traversal was spread across many top-level items was
previously unbounded: each item got a fresh budget, so a file of N items could
spend N times the intended limit. The budget now lives on the extraction and is
charged once per revisit wherever it happens.

Two consequences worth knowing before upgrading:

- `truncated` can now appear on files that did not report it before, with
  reason `item-revisits`. Nothing is dropped silently — that is the point of
  reporting it — but a consumer that treats any `truncated` as an error will
  see it more often. The bound's value was not re-sized for its wider scope, so
  a large nested block import spread over many products can truncate where it
  previously completed.
- First visits are still never charged, and the "seen" set stays per item, so
  re-placing one library block many times is not counted as revisiting it.
