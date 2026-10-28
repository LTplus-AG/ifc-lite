---
"@ifc-lite/ifcx": minor
"@ifc-lite/parser": minor
---

Federated composition can keep every layer's own value per attribute, not only the winning one. Pass `retainOpinions: true` to `composeFederated`, `parseFederatedIfcx` or `addIfcxOverlay`; composed nodes then carry `opinions` (weakest first, strongest last, matching the buildingSMART `GetOpinions` shape) and the parse result carries `attributeOpinions`. `findDivergentAttributes` lists the attributes where layers hold different values, so a disagreement such as two layers setting different fire ratings is no longer silently decided by stack order. Off by default; ordinary composition is unchanged. `@ifc-lite/parser` re-exports `findDivergentAttributes` and the opinion types alongside its other IFCX exports.
