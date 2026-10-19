<!-- SPDX-License-Identifier: MPL-2.0 -->
# Generated bindings and imported provenance

Both generation commands and imported verification completed successfully on the exact source in receipt.json. The worker postcondition correctly rejected tracked generated changes; exit 1 is not a compiler failure or a source-clean qualification pass.

The five generated files were copied without edits after matching the logged hashes. All imported provenance input hashes match the integrating source. Imported executable bytes are unchanged; the Cargo.lock fingerprint changed. Canonical WASM adds the retained public binding surface. The full original log and receipt are retained, with the log SHA verified.

A subsequent integration commit removes the redundant private plane accessor warning; its generated surface still requires clean repeat validation. Runtime, browser, package, installed-consumer, platform and performance qualification remain separate.
