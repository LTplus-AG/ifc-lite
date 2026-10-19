<!-- SPDX-License-Identifier: MPL-2.0 -->
# Exact source terminal results

Clean repeat imported generation, verification, canonical WASM build and generated-file identity all pass. Subsequent checks fail setup: missing root dependency install and renderer build, then Turbo is not found. The corrected command explicitly installs frozen dependencies and runs the root build before boundary tests. These failures provide no typecheck, Turbo test or WASM contract behavior result. Original request and output remain unchanged.

The output was read back from its original worker and verified against the unchanged original receipt SHA256. Historical passes are not assigned to later source. Worker storage remains pending ordinary owner closure; no active/foreign workspace or shared cache was reclaimed.
