# 03: Provenance Manifest

## 3.1 Schema (extension namespace `ifclite::provenance`, manifest SemVer v1)

```json
{
  "ifclite::provenance": {
    "v": 1,
    "author": {
      "kind": "agent | human | hybrid",
      "principal": "louis@ltplus.ch",
      "tool": "@ifc-lite/mcp@0.4.0",
      "model": "claude-fable-5",
      "session": "uuid-v7"
    },
    "intent": "Reclassify load-bearing walls per fire-safety Pset configuration",
    "instructions_digest": "blake3:...",
    "created": "2026-06-09T14:02:11Z",
    "base": { "kind": "layer | stack", "id": "blake3:..." },
    "parents": ["blake3:..."],
    "scope_claim": ["model.mutate:Pset_FireSafety*@IfcWall&storey=EG"],
    "identity_map": [{ "base": "3fA$...", "here": "1xQ9...", "reason": "exporter regenerated GlobalId" }],
    "checks": [
      { "tool": "@ifc-lite/ids@2.x", "spec": "fire-zones.ids", "specDigest": "blake3:...", "result": "pass", "report": "blake3:..." }
    ],
    "merge": null,
    "signatures": [{ "alg": "ed25519", "key": "...", "sig": "..." }]
  }
}
```

Field semantics:

- **author.kind = hybrid**: a human steering an agent in one draft. Both principals appear (human as `principal`, agent identity in `tool`/`model`/`session`)
- **intent**: human-readable why. Mandatory. This is the line that appears in `ifc layer log` and the review UI
- **instructions_digest**: blake3 of the full prompt/task text that produced the layer. The text itself is stored by the registry (access-controlled) so audits can answer "what exactly was this agent told", while the layer stays free of potentially sensitive prose
- **scope_claim**: capability-grammar expressions (07 §7.1). Verified against actual ops at publish and merge time; mismatch is an automatic review flag, never silently accepted
- **merge** (merge layers only): `{ candidate, into, resolutions: [{entity, componentKey, choice: ours|theirs|edited}], waived_checks: [...] , resolver }`
- **signatures**: ed25519 over the layer id. Optional in v1; field present from day one so the format never breaks. Registry policy can require signatures for protected refs (10 §10.4)

## 3.2 Trust model

Three escalating levels, all using the same manifest:

1. **Local**: manifests are self-asserted. Good enough for solo + small-team work; the value is the record, not the proof
2. **Registry-attested**: the registry signs receipt (layer id, timestamp, authenticated principal). Protects against backdated or impersonated layers within a team
3. **End-to-end signed**: authors hold keys; protected refs require valid signatures from authorized principals; agent keys are distinct from their operators' keys, so "which agent, run by whom" is cryptographically answerable

The star-reach version: an industry where a building's as-built model carries an unbroken signed chain from every contributor (human, vendor tool, agent) back through design. Digital Building Logbook (DBL) work and DPP threads plug in here: a DPP-enriched manufacturer dataset enters the model as a signed layer from the manufacturer's principal.

## 3.3 Privacy

- Manifests carry principals: registry visibility rules apply (10 §10.5); `--anonymize` on export rewrites principals to stable pseudonyms
- `instructions_digest` indirection keeps prompts out of the shareable artifact by design
