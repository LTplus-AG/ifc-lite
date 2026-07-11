# 07: Security and Capability Model

## 7.1 Reuse the extensions capability grammar

`packages/extensions/src/capability/` (parse, match, diff, risk, catalogue) was built for user extensions and transfers verbatim: layers are just another principal asking for authority. Relevant catalogue entries already exist: `model.read` (green), `model.mutate` with required target pattern (yellow), `model.create` (yellow), `model.delete` (red). Spec: `docs/architecture/ai-customization/02-security.md` §3.1.

Scope expressions in manifests and grants use the same grammar, extended with entity selectors:

```text
model.mutate : Pset_FireSafety* @ IfcWall & storey=EG
model.create : IfcPropertySet
model.delete : @ IfcAnnotation            [red tier: registry policy may forbid for agent principals]
```

## 7.2 Enforcement points (defense in depth)

1. **Write time** (MCP/SDK boundary): op matched against the draft's grant; violation rejected with structured error. Agent gets immediate feedback
2. **Publish time**: actual ops verified against `scope_claim`; over-claim trimmed is forbidden, mismatch flags the layer and downgrades it to mandatory-review
3. **Merge time**: target ref policy evaluates (author kind, risk tier of touched capabilities, required checks, signature requirements). Red-tier ops from agent principals can be policy-blocked outright
4. **Audit time**: `extensions/audit/` records every grant, every flag, every waiver, queryable by principal

## 7.3 Threat model (selected)

| Threat | Mitigation |
|---|---|
| Prompt-injected agent attempts destructive edits | Scope grant excludes `model.delete`; write-time rejection; even in-scope damage is a reviewable layer, never main |
| Agent over-claims a narrow scope, edits broadly | Publish-time op-vs-claim verification; mismatch flag |
| Backdated / impersonated layer | Registry attestation (03 §3.2 level 2); signatures (level 3) |
| Poisoned base (malicious layer deep in a stack) | Content addressing: stack hashes pin exact ancestry; any recomposition detects substitution |
| Check evasion (merging with red checks) | Required checks are ref policy, enforced server-side by the registry, not client-side |
| Exfiltration via manifest prose | `instructions_digest` indirection (03 §3.1); registry access control on prompt text |

## 7.4 The sentence that sells it

"I let the agent write fire-safety Psets on walls in one storey, behind IDS checks and review, with every action signed and auditable." Every clause maps to a mechanism above. Nothing in the AEC market can currently produce that sentence.
