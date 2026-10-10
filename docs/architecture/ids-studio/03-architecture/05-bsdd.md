# bSDD integration

## 1. What exists
- SDK client `packages/sdk/src/namespaces/bsdd.ts` (class info, by URI, search, related classes, property sets, quantity sets, entity attributes; LRU/TTL cache; configurable base).
- Viewer proxy `/api/bsdd` (Vite dev proxy + Vercel rewrite), `services/bsdd.ts`, `BsddCard.tsx` (add bSDD property to an element).
- MCP `bsdd_search|class|property_sets|match`; CLI `ifc-lite bsdd`.
- **Gap:** none of it connects to IDS.

## 2. Capabilities to build (P-06)

### 2.1 Pickers (FR-E01, FR-E02)
- Search box in entity, classification and property pickers with a "bSDD" tab. Filters: dictionary (default list configurable per document: e.g. IFC dictionary, project dictionaries), language, related IFC entity (pre-filled from applicability), status (active only by default).
- Result card: class name, code, dictionary + version, definition, related IFC entities, property count, status. Preview of properties.
- Insert as:
  - **Classification facet:** `system` = dictionary name (as bSDD exposes it; lint BSDD-002 checks alignment), `value` = class code, `uri` = class URI. Applicability or requirement.
  - **Entity facet:** the related IFC entity (+ predefined type if bSDD gives one). If several entities are related, offer an enumeration or the choice.
  - **Both** (common pattern: "applies to IfcWall classified as X").

### 2.2 Properties → requirements (FR-E03)
For each selected class property:

| bSDD field | IDS mapping |
|---|---|
| `propertySet` | `propertySet` (if absent: a project pset name the user picks; custom-declared) |
| `name` | `baseName` (IFC-standard properties from the IFC dictionary keep the exact EXPRESS name); `BsddClassProperty` does not currently expose a property `code` |
| `dataType` (String, Real, Integer, Boolean, Time, Character…) | IFC dataType via a mapping table, refined by `propertyValueKind` and units (e.g. Real + unit `m` → IFCLENGTHMEASURE) |
| `allowedValues[]` | `oneOf` using each entry's `value`; retain optional `uri` and `description` as source/display metadata, not replacement values |
| `minInclusive/maxInclusive/pattern` (not in the current SDK shape) | Future mapping requires a qualified API/SDK extension with recorded payload fixtures; no range/pattern is inferred from missing fields |
| `units` | SI conversion note; lint UNIT-001 cross-check |
| `uri` | property facet `uri` attribute |
| `isRequired` (not in the current SDK shape) | Future mapping requires a qualified API/SDK extension; current inputs cannot establish a required/optional default |

The mapping plan is bounded by `BsddClassProperty` in `packages/sdk/src/namespaces/bsdd.ts`. Unsupported source fields need a typed SDK/API extension and recorded-fixture qualification in P-06 before use; no requirement or constraint may be invented from their absence. The mapping table is planned in `ids-authoring/bsdd-mapping.ts` with tests per bSDD data type. Unknown mappings fall back to no dataType, plus info lint PROP-003.

### 2.3 Dictionary → IDS (FR-E04)
- Choose a dictionary (+ version) → tree of classes (with parent/child) → multi-select → options:
  - one spec per class, or one spec per related IFC entity with classification enumeration
  - include inherited properties from parent classes (bSDD class hierarchy) ✚, which existing converters lack
  - property scope: required only / all
  - spec cardinality default
- Preview: number of specs and facets, lint summary, and (if a model is loaded) funnel counts per spec.
- Apply as one `bulk.fromBsddClass` transaction.
- Re-run on a new dictionary version → diff against the current IDS (P-10 diff) → update proposal. This keeps dictionary and IDS in sync (J10).

### 2.4 URI health (FR-E05)
- Background check (rate-limited, cached 24 h) of all URIs in the doc: exists, status, replaced-by. Lints BSDD-001/002/003.

### 2.5 Export to bSDD (FR-E06, later)
- Custom psets/properties declared in the doc → bSDD import JSON (dictionary draft) for upload by the user. No write-back via API in v1 (decision D6).

## 3. Agent tools
`bsdd.search`, `bsdd.class`, `bsdd.properties`, `bsdd.resolveUri` are exposed to the agent (see `06-ai-agent.md`). The gate treats bSDD-sourced names as grounded once resolved through these tools in the same run.

## 4. Robustness
- All calls go through the proxy with timeouts. Cached in IndexedDB (results + class details) so offline authoring of known classes works (FR-E07).
- Language: request the user's UI language with fallback to English. Labels are stored for display only; IDS values use codes and URIs.
- Rate limits: debounce search at 250 ms; batch URI health checks.
- Privacy: only search terms and URIs are sent to bSDD, never model data.
