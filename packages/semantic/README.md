# @ifc-lite/semantic

Portable semantic datasets and profile-driven validation for browser and headless IFC applications. RDF terms retain datatype, language, blank-node identity, repeated values and unbound SELECT columns. Domain profiles are optional projections over the preserved dataset.

Providers parse SPARQL with Traqula before allowing SELECT or CONSTRUCT. UPDATE and SERVICE are denied; FROM needs explicit graph authorization. HTTPS requests reuse the sandbox network capability, byte limit, cancellation and redirect policy through its small `network` entry point. Bearer tokens live only in a request. Browser endpoints still need CORS; the Node relay is an explicitly configured alternative.

Resolution requires an explicit strategy and revision association. Duplicate IFC GlobalIds remain ambiguous. A missing revision never falls back to an unrelated loaded model. Workspace version 1 exports portable query settings, raw datasets and revision labels; import resets grants and loaded-model associations. Credentials and URL query parameters are excluded from portable endpoint configuration.

```typescript
import { createSemanticProvider, ResolverRegistry } from '@ifc-lite/semantic';
const result = await createSemanticProvider().read({
  endpoint: 'https://example.org/sparql', host: 'example.org', kind: 'select',
  query: 'SELECT ?subject ?predicate ?object WHERE { ?subject ?predicate ?object } LIMIT 100',
}, new AbortController().signal);
const resolvers = new ResolverRegistry();
```

This package does not claim conformance to CEN working drafts. Example DBL/DPP vocabulary is original, synthetic pilot data. JSON Schema and SHACL validate explicit profiles; OWL entailment is optional and not assumed.

Identity strategies include direct IFC GlobalId, explicitly configured profile fields (`createProfileMappingStrategy`), and portable resource links (`createResourceLinkStrategy`). A resource link stores a resource URI, a non-empty opaque model revision identifier, and IFC GlobalId. Every linked revision must have exactly one declaration in the workspace; loading a workspace leaves these declarations pending until the user associates them with loaded models. Domain profiles can impose stronger constraints, including revision IRIs in the reference profile. The resolver checks current live entities on every action; deleting/reloading a model cannot preserve a stale numeric express id. Several candidate identities are reported as ambiguous.

Workspace dataset resource properties use RDF term arrays, not the flattened profile document shape. Store the generated RDF graph and optional raw SELECT rows when preserving a profile submission. Saved endpoints intentionally disallow URL search parameters so credentials cannot be hidden in the endpoint URI. Bearer credentials, network grants and loaded model ids are session settings and require reentry after import. Source data itself can contain sensitive information; callers should review exports before sharing.

Resource URI identity uses `createResourceUriStrategy({ mode: 'template', template: 'https://lbd.org/{GlobalId}' })`, or the explicit `{ mode: 'last-path-segment' }` option. Register it with `ResolverRegistry` and resolve `{ id: resourceUri, modelRevision }` against current live entities. No separate GlobalId property is needed. The full literal template has one path placeholder; extracted identifiers reuse canonical GlobalId validation, model/revision scope and ambiguity handling. Only map URI RDF terms to this identity input. URI identifiers remain unchanged, including when a captured percent-encoded identifier is decoded once for matching. Reverse template discovery inserts a raw compressed GlobalId; use known original subjects when their encoded spelling differs. Last-segment mode cannot infer an unknown namespace. See the [viewer workflow](../../docs/guide/semantic-pilot.md#map-ifc-identity-encoded-in-resource-uris).
