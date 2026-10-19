<!-- SPDX-License-Identifier: MPL-2.0 -->
# Exact source terminal results

SDK WASM builds and six of eight CTests pass; affine endpoint and diagonal topology boundaries fail. The previous negative-zero section-key failure passes on this source. Browser provisioning succeeds. All three Rust browser lanes reject missing --chrome before compiling/executing tests. Canonical WASM build and declaration identity pass. Actual Playwright reaches the page and fails module linkage: the generated constructor imports Driver instead of exported RetainedDriver. Root fixes its annotation at e1a1a82b68; execution remains pending. Full original output and page error context are preserved. No browser numerical pass is claimed.

The output was read back from its original worker and verified against the unchanged original receipt SHA256. Historical passes are not assigned to later source. Worker storage remains pending ordinary owner closure; no active/foreign workspace or shared cache was reclaimed.
