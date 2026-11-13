# Archived generated inventory — #8947

The generated source census and historical runtime bindings are preserved in the
immutable pre-consolidation snapshot below rather than repeated in this PR diff.
No test or application module reads these reports. All original identities,
anchors, qualifications and failed/unrun verdicts remain available unchanged.

Snapshot: `e530cfed5e52fd83229262abda9e414371f1128f`.

| Report | Bytes | SHA-256 |
| --- | ---: | --- |
| [executed-route-bindings.jsonl](https://github.com/LTplus-AG/ifc-lite/blob/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory/executed-route-bindings.jsonl) | 87847 | `2e6707d88cf4f3994e7cba808bed18bed43b2bbbecbfe1c7b952992276c74ce4` |
| [executed-route-provenance.json](https://github.com/LTplus-AG/ifc-lite/blob/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory/executed-route-provenance.json) | 4434 | `150dce8f964bf66e648b6afc25f1b25a17d5123ff5da4ed70dd110e08b0e30b8` |
| [historical-child-bindings.jsonl](https://github.com/LTplus-AG/ifc-lite/blob/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory/historical-child-bindings.jsonl) | 71340 | `c569092766c88750b5688224a613885649221e4d57c6c31fa48bb5d7cfdcc35f` |
| [historical-child-provenance.json](https://github.com/LTplus-AG/ifc-lite/blob/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory/historical-child-provenance.json) | 39155 | `928a05466e671e708fd72ceeddf137a1a0eda974d292cdd60922da3992fd562d` |
| [provenance.json](https://github.com/LTplus-AG/ifc-lite/blob/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory/provenance.json) | 3414 | `06aad90d35ae38d382aed5ae2611c3df9bab79a687a6a31b17a0db05158901dc` |
| [source-controls.jsonl](https://github.com/LTplus-AG/ifc-lite/blob/e530cfed5e52fd83229262abda9e414371f1128f/tests/ui-scenes/command-palette-access/inventory/source-controls.jsonl) | 3198079 | `a950bbea5b7abe87bce3167fc104f9fe3322b0636983c76c0d4a210369526eb9` |

These files are historical evidence, not current acceptance. The prose route
findings in this directory remain tracked. To inspect exact bytes locally, use
`git show <snapshot>:tests/ui-scenes/command-palette-access/inventory/<report>`.
The existing `update-inventory.mjs` prepares the source census from the original
coordinator reports; its generated JSON outputs are ignored.
