---
"@ifc-lite/ifcx": patch
---

Fix `validateProvenance` silently accepting an untrusted manifest that omits the required `merge` field entirely. Per `docs/architecture/layer-prs/03-provenance.md` §3.1 and the `ProvenanceManifest` type (`merge: MergeRecord | null`, not optional), every manifest carries `merge`, as `null` for non-merge layers. The check treated `undefined` the same as `null` and skipped validation, so a manifest missing the key passed with zero errors; it now matches the sibling `base` field's pattern and only exempts a literal `null`.
