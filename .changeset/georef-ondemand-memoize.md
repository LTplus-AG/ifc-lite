---
"@ifc-lite/parser": patch
---

perf(georef): memoize `extractGeoreferencingOnDemand` per store

On models without an `IfcMapConversion`, the on-demand georeferencing extractor
scans and decodes every `IfcPropertySet` from the source buffer to find
`ePset_MapConversion` / `ePset_ProjectedCRS`. On property-set-heavy models that
is tens of thousands of entity decodes per call, and the viewer invokes it on
the render path (once per streamed geometry batch), so the cost compounded to
O(batches x propertySets) and could stall large-model loads by an order of
magnitude. The result is a pure function of the immutable source + entityIndex
(georef edits are layered on top later in `getEffectiveGeoreference`), so the
extraction is now memoized per store via a `WeakMap`, collapsing it to a single
scan per model. Not-yet-loaded stores (missing source/entityIndex) are not
cached, so a store that fills in later still recomputes.
