# Shared appearance atlas extraction (#4381)

Finite-page composition delegates its existing canonical target discovery,
material preservation, chart layout and image binding to an internal sampler
interface. The page sampler retains the existing projection and alpha composition.
No public API or output format changes in this refactor.

The existing page tests exercise two objects, canonical IFC/PNG reopen, repeated
page application, high-frequency source texture preservation, transparency,
material fields and refusal budgets. Existing evaluated occurrence tests cover
the shared planner entry/exit added under #4404.

[The output comparison](page-output.json) calls actual pre-refactor F6 WASM and
the transfer-stack runtime containing this extraction with the same controlled
triangle, original RGB, finite red page and density. Their complete IFPA response
(metadata and encoded PNG, 2,547 bytes) is byte-identical. The after-runtime also
contains the separately planned transfer API; this check invokes only the existing
page API and is not a claim that transfer itself is enabled by this refactor.
