# Linked records and semantic queries

Open **Linked records** from the viewer's workspace panel browser. Choose
**Load pilot models and records** to load two original IFC door models through
the canonical viewer loader, and associate their revision identifiers. The
models deliberately reuse GlobalIds; their positions differ by three metres.
The viewer must therefore use the revision association to resolve a record.

This is an original, executable demonstration of the architecture discussed in
[discussion 6635](https://github.com/LTplus-AG/ifc-lite/discussions/6635).
It contains no confidential working-group material and makes no EN / ISO
conformity claim.

## Sources, arbitrary results and workspaces

The panel accepts local profile JSON, Turtle, N-Quads, inline JSON-LD, HTTPS JSON,
and SPARQL SELECT or CONSTRUCT. SELECT rows render independently of domain
profiles, including arbitrary columns, unbound values, blank nodes, datatypes
and language tags. Fifty rows render per page. Optional profile projection
reports incompatible bindings without discarding the raw rows.

Enter the exact allowed hostname for a remote request. A bearer credential is
held only in the current panel session. For a configured relay, enter its HTTPS
URL, hostname and authorized provider ID; see [headless providers](semantic-headless.md).
Browser requests require endpoint CORS. Run/cancel bounds transport and worker
jobs; late data from a changed model session is refused.

Binding mapping names identify the resource URI, GlobalId and revision columns.
Duplicate GlobalIds show all candidates; choose a candidate explicitly or
associate a revision with its loaded model. Saved workspaces preserve records,
raw rows, graphs, profile definitions and query presets. Restoration clears
host grants, bearer credentials and model associations. Reassociate revision
identifiers after reload; display names never establish identity.

**Query records related to IFC selection** resolves current IFC selection to
known semantic URIs and runs a bounded query for outgoing and incoming links.
With no known subject, the selected profile's GlobalId predicate performs
explicit discovery. Identifiers are serialized into VALUES, not executable
query text. Related query results use their `subject` URI for explicit resource links,
while the query editor retains your analytical binding mapping. This is a partial supplied view and cannot establish endpoint-wide
conformance.

Load a versioned profile definition in the profile controls, generate its
schema/context/vocabulary/shapes/dictionary, or import bSDD definitions. See
[profiles and validation](semantic-profiles.md) for the supported subset and
language, units and completeness contracts.

Projection previews show the IFC address, GlobalId/revision, previous and new
value, target property, mapping and conflict policy. A changed preview is
refused. Choose reject, skip or overwrite for conflicting properties.
FireRating targets `Pset_DoorCommon.FireRating`; thermal transmittance targets
`Pset_WallCommon.ThermalTransmittance` in W/(m2.K), including explicit conversion
from mW/(m2.K). Provenance records the source declaration, profile and mapping
versions, identifiers and projection time. Retrieval time is included only
when it was actually recorded. Grouped undo/redo and the normal IFC export
retain the canonical editor behavior. External relationships remain in the
workspace and semantic bundle.

## Try the complete workflow

1. Load the pilot. Three current installations resolve to the first model;
   the previous installation resolves to the second. One installation is
   unmatched. The deliberately incomplete passport produces two JSON Schema
   findings and two SHACL findings.
2. Click **Shared door batch** to highlight its installations, or click an
   installation to highlight one door. Clicking inspection evidence follows
   its installation link. An ambiguous or unmatched installation clears
   selection rather than guessing. The renderer and property selection receive
   the same model-scoped entity addresses.
3. Select an IFC door in the viewport and enable **Records related to current
   IFC selection**. The panel shows the connected record context, including
   logbook, product, passport, replacements and inspection relationships. This
   context can include other installations in the same building; row actions
   use ownership links to select only the corresponding installations.
4. Select **Installed door 1**, enable the viewer's **Edit** mode and choose
   **Preview projection**. Review the target and proposed value, then choose **Apply reviewed projection**. The effective IFC overlay gets
   `Pset_DoorCommon.FireRating = EI30` and `Pset_SemanticProjection` provenance
   with source, profile, product, installation, timestamp and property mapping.
   One undo reverses the whole projection. Ordinary IFC export includes these
   properties. Editing permissions and collaboration permissions still apply.
5. Inspect the retained relationships and validation findings. The inspection
   PDF URI is external evidence; the pilot does not fetch it. Validation rows
   select the associated installation where an ownership path exists.
6. Download the bundle. It contains records, JSON Schema, inline JSON-LD
   context, JSON-LD, N-Quads, SHACL shapes, RDFS vocabulary, neutral dictionary
   projection, SELECT query, raw bindings and session revision associations.
   Paste a record document or the downloaded bundle into **Local JSON** to
   reload it. Load a versioned profile explicitly in **Profile and dictionary**;
   imported records never silently replace the selected profile.

Loaded records survive panel switches. **Save and download workspace** also
stores the versioned workspace locally. After reload, choose **Restore saved
workspace** or import its JSON. Restored endpoints require a new hostname grant;
credentials and session model associations are cleared. Reassociate revision
URIs with newly loaded models.

## JSON and SPARQL sources

**JSON endpoint** performs a GET for a record document or bundle. **SPARQL
endpoint** POSTs a SELECT query as `application/x-www-form-urlencoded` and
expects standard SPARQL Results JSON. Enter the exact hostname you allow in
the separate hostname field. HTTPS and CORS are required; credentials are not
stored. **SPARQL CONSTRUCT graph** retrieves Turtle using a CONSTRUCT query.
Redirects, SPARQL UPDATE, ASK, SERVICE and unauthorized FROM datasets are rejected.
Requests have a 15 second timeout and a 5 MiB response cap. Cancel stops an
outstanding request and prevents late results from replacing current records.

The raw binding table preserves URI, literal and blank-node kinds, language
tags and datatypes. Unbound values stay absent. The pilot resource projection
is intentionally narrower: URI resource ID, supported type and literal label
are required. Mapping controls rename the `id`, `type`, `label`, `GlobalId` and
`modelRevision` bindings; other properties use their profile names. Repeated
identical rows deduplicate; conflicting rows for one resource are rejected.
The raw result remains a SELECT view, never proof that an entire endpoint was
validated. SPARQL imports are explicitly **partial**.

## One profile, several representations

The field/type definitions generate the closed JSON Schema, JSON-LD context,
SHACL Core shapes, RDFS vocabulary and dictionary projection. There is no
independently hand-maintained second ontology. RDFS describes the vocabulary;
Schema and SHACL enforce the supplied profile. There is no OWL inference or
remote-context loading. SHACL validation uses explicit resource types, rejects
graphs with no pilot targets, and bounds graph input to 5 MiB / 50,000 quads.
The displayed RDF is editable for independent graph validation. Editing it
invalidates previous findings and cancels pending validation. Restored workspaces
remain unvalidated until validation completes for the restored data. The report
shows the actual validation scope, engines, completeness and finding-limit status;
validating a supplied graph does not claim JSON Schema validation of the records. The bundle
exports the current graph with its explicit `graphFormat`; the `nquads` field is
present only when that graph is actually N-Quads. Edited graph data does not
change the accompanying profile JSON records.

The conceptual entities are Building, Logbook, Installation, Product, Passport
and Inspection. Products and passports carry model/batch/item granularity.
Multiple installations can reference one batch product. `dictionaryUri`
identifies a semantic concept, independently of the physical product ID.
Ordinary absolute URIs, URNs and DIDs can be record identifiers; this pilot
does not implement DID resolution, authentication or signatures. The neutral
dictionary format is a neutral, documented subset. The profile controls also
import supported bSDD definitions through the existing versioned SDK adapter.
Unsupported relations remain available in the original imported payload with
diagnostics; dictionary definitions do not supply manufacturer instance values.

Choose the GlobalId resolver, explicit resource-to-entity links, or profile
identity fields. Each strategy resolves against effective IFC identities and
explicit revision/model associations. Duplicate GlobalIds remain ambiguous
unless that evidence disambiguates them.
Resolution re-reads effective attributes, created entities and tombstones at
each action, so model removal or overlay edits cannot reuse cached addresses.
Building/product/passport identity and arbitrary logbook relationships remain
outside IFC. Supported projection mappings copy declared FireRating to IfcDoor and thermal transmittance to IfcWall / IfcWallStandardCase through the canonical mutation backend.

A **complete** submission additionally checks referenced internal resources
for presence. A **partial** view can omit related resources without producing
false completeness failures. Both check the types of referenced resources
when those resources are present. External evidence URIs are not completeness
targets. Neither representation proves issuer trust or regulatory compliance.

## Reproduce assets and endpoints

From the repository root, after installing dependencies and building workspace
packages:

```bash
pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/semantic-pilot.ts /tmp/ifc-lite-semantic-pilot
```

This writes both IFC revisions, records (including a valid-only variant),
schema, context, JSON-LD, N-Quads, shapes, vocabulary, dictionary and SELECT.
For an actual localhost HTTPS JSON / SPARQL endpoint, supply a certificate
trusted by your browser (for example, an existing local development certificate):

```bash
pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/semantic-pilot.ts --serve /path/to/localhost.pem /path/to/localhost-key.pem 8443
```

Use `https://localhost:8443/records` or `/sparql`, hostname `localhost`, and the
panel's default SELECT. The endpoint binds only to loopback and serves only
synthetic demonstration data. It is a development aid, not a deployed service.

## Verification

The viewer's `semantic-pilot.test.tsx` exercises a real Oxigraph SELECT engine,
real HTTP GET/POST, JSON/SPARQL equivalence, Schema/SHACL findings, closed-shape
rejection, transport denial/cancellation, single-model and federated
selection, effective GlobalId edits/deletions, projection provenance and
grouped undo, mounted row actions and selection filtering, panel remounts, and
actual WASM door meshes from both authored revisions. Run through root turbo:

```bash
pnpm typecheck
TEST_SHARD=4237 TEST_SHARDS=10007 pnpm test --filter=@ifc-lite/viewer --env-mode=loose
```

The narrow shard selects the pilot test file; ordinary viewer test runs include
it automatically. Browser geometry needs the built WASM runtime; use
`pnpm build:wasm:fetch` when local Rust compilation is unavailable.
