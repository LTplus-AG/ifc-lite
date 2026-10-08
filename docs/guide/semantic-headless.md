# Headless semantic records and authenticated relay

The `semantic` command uses `@ifc-lite/semantic`, the same portable providers, technology-neutral profiles, and validators as the viewer's Linked records panel. It does not require GPU geometry or a running viewer. The reference profile and demonstration data use original `example.org` identifiers; they do not claim compliance with a CEN, ISO, DPP, or bSDD exchange specification.

## Generate and validate profile artifacts

```bash
ifc-lite semantic assets --artifact profile --out profile.json
ifc-lite semantic assets --profile profile.json --artifact schema --out schema.json
ifc-lite semantic assets --profile profile.json --artifact context --out context.json
ifc-lite semantic assets --profile profile.json --artifact shapes --out shapes.ttl
ifc-lite semantic assets --profile profile.json --artifact vocabulary --out vocabulary.ttl
ifc-lite semantic validate records.json --profile profile.json --json
ifc-lite semantic validate records.nq --profile profile.json --json
ifc-lite semantic validate graph.ttl --shapes shapes.ttl --json
```

JSON inputs undergo structural parsing, profile JSON Schema validation, and link validation. A `complete` submission requires every internal target to exist; a `partial` submission permits targets outside that submission. An existing target with the wrong type remains an error in either mode. RDF inputs use SHACL, independently of JSON validation. A SHACL report does not certify the completeness of an external dataset. The report's `engines` field states which checks ran.

The JSON report contains profile ID/version, scope, completeness, limits, severity counts, conformance, truncation, engines, and findings. Each finding identifies its engine, resource identifier, path, and message. The command exits with status 1 for nonconformance. Malformed inputs and failed requests also produce an error exit; they are reported on stderr rather than a conforming report. Graph validation with no focus nodes is an error. RDF extensions `.ttl`, `.nt`, `.nq`, and `.jsonld` select graph validation automatically; `--rdf` handles other filenames. `--graph-format turtle|nquads|jsonld` explicitly selects the syntax. Inline JSON-LD is converted through the same safe graph importer as the viewer.

`--shapes` applies to RDF inputs. Imported shapes are restricted to the documented bounded SHACL Core subset. SPARQL constraints, executable functions, recursive shape composition, complex paths, and malformed or cyclic RDF lists are rejected. Shape and graph bytes, quad counts, and report size are bounded. JSON-LD conversion uses the generated inline context and does not fetch remote contexts.

## Read JSON, SELECT results, or CONSTRUCT graphs

```bash
ifc-lite semantic query --endpoint https://data.example.org/records --host data.example.org --json
ifc-lite semantic query --endpoint https://data.example.org/sparql --host data.example.org --query query.rq --out results.json
ifc-lite semantic query --endpoint https://data.example.org/sparql --host data.example.org --query construct.rq --kind construct --out graph.ttl
ifc-lite semantic query --endpoint https://data.example.org/private --host data.example.org --bearer-env SEMANTIC_PROVIDER_TOKEN --json
```

The explicit `--host` grant is checked before network access. Requests require HTTPS and refuse redirects. Response reads are capped at 5 MiB and 15 seconds. SELECT accepts W3C SPARQL Results JSON, preserving blank nodes, datatypes, languages, projected columns, and absent bindings. CONSTRUCT accepts Turtle. Query parsing rejects SPARQL Update and `SERVICE`; the CLI does not authorize `FROM` datasets. SELECT results are written in the W3C JSON envelope; CONSTRUCT writes RDF text, or a JSON string when `--json` is requested. JSON providers retain their JSON payload.

Credentials are supplied through named environment variables, never command arguments or saved query files. Provider responses that contain the supplied bearer credential are rejected. Known credential values are redacted from CLI errors and output. Endpoint source metadata excludes URL query strings and fragments. The provider and viewer do not persist bearer tokens in workspace exports.

## Operate an authenticated HTTPS relay

A relay supports endpoints that require private credentials or do not allow browser CORS. Its configuration binds a provider ID to a fixed HTTPS endpoint and an exact hostname grant. Endpoint URLs with embedded credentials, query strings or fragments are rejected at startup. Callers supply the provider ID and a read query; they cannot supply an upstream URL, host, or credential.

Create `relay.json` using environment references only:

```json
{
  "clientTokenEnv": "SEMANTIC_RELAY_CLIENT_TOKEN",
  "allowedOrigins": ["https://viewer.example.org"],
  "providers": {
    "catalogue": {
      "endpoint": "https://data.example.org/sparql",
      "grantedHost": "data.example.org",
      "kind": "sparql",
      "bearerEnv": "SEMANTIC_PROVIDER_TOKEN"
    },
    "records": {
      "endpoint": "https://data.example.org/records",
      "grantedHost": "data.example.org",
      "kind": "json"
    }
  }
}
```

Set these environment variables through the hosting environment's secret mechanism. The client token must contain at least 32 characters. `bearerEnv` is optional for public upstream providers. Start the relay with a trusted TLS certificate and private key:

```bash
ifc-lite semantic serve --config relay.json --cert certificate.pem --key private-key.pem --port 8443
```

The listener binds to `127.0.0.1`; expose it through a trusted HTTPS hosting boundary as needed. It serves the relay handler on every path. Configure the viewer or CLI with the relay's HTTPS URL, hostname grant, provider ID, and ephemeral client token. A CLI request uses the same shared provider:

```bash
ifc-lite semantic query --endpoint https://relay.example.org/semantic --host relay.example.org --relay-provider catalogue --bearer-env SEMANTIC_RELAY_CLIENT_TOKEN --query query.rq --json
```

The wire request is `POST application/json` with `Authorization: Bearer <client token>` and body `{"providerId":"catalogue","kind":"select","query":"SELECT ..."}`. `kind` can be `json`, `select`, or `construct`. The response contains the upstream JSON/SELECT envelope or Turtle graph using its standard content type. The relay validates query kind and uses the shared provider to parse and bound the upstream response. It never forwards the client token upstream.

An exact allowed HTTPS origin receives CORS headers; a different origin is denied. Nonbrowser clients without an Origin header still require the bearer token. Preflight permits only POST with Authorization and Content-Type. Responses use `Cache-Control: no-store`. Unauthorized requests return 401, origin violations 403, unknown providers 404, invalid requests 400/415, upstream failures 502, and timeouts/cancellation 504. Upstream errors and credential values are not returned to the caller.

For embedding in an existing Node HTTPS host, `@ifc-lite/semantic/server` exports `createSemanticRelay` (Fetch Request/Response handler) and `createSemanticRelayServer` (Node HTTPS adapter). Provider credentials can be resolved at request time through `bearerToken: () => string | undefined`. Deploy the handler behind HTTPS and configure explicit origins and provider grants; imported workspace files do not authorize new relay destinations.

## Reproduce the original demonstration

```bash
pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/semantic-pilot.ts /tmp/ifc-lite-semantic
ifc-lite semantic validate /tmp/ifc-lite-semantic/records-valid.json --json
ifc-lite semantic validate /tmp/ifc-lite-semantic/records.nq --json
pnpm exec tsx --tsconfig apps/viewer/tsconfig.json apps/viewer/scripts/semantic-pilot.ts --serve certificate.pem private-key.pem 8443
```

The generated profile records include an intentionally incomplete passport; validation of `records.nq` therefore reports findings. The `/records` and `/sparql` endpoints expose the reference profile. `/generic` exposes a separate arbitrary RDF graph with multilingual and multivalued labels, blank nodes, typed decimal/date/boolean literals, and relationships that have no IFC representation. `generic-query.rq` and `construct-query.rq` exercise SELECT and CONSTRUCT. `/large` serves 5,000 original synthetic label triples through the same query engine for exercising the browser row budget; use `generic-query.rq` against that endpoint. The demonstration endpoint is a public local fixture with permissive CORS; production private endpoints use the authenticated relay.

The canonical ArchiCAD 20 FZK IFC fixture is independently authored ground truth for the viewer integration test. Fetch it with `node scripts/fixtures/fetch-fixtures.mjs ara3d/AC20-FZK-Haus.ifc`. That test verifies its manifest SHA-256, the known door GlobalId, duplicate-GUID federation, revision-bound selection, synthetic property declaration projection, export/reimport provenance, and undo. The synthetic declaration is not a fire-performance claim about the reference building.

## Measure the headless resource budget

After the root build, run `node scripts/perf/semantic-budget.mjs --iters 5 > /tmp/semantic-budget.json`. The standalone report records Node/OS/CPU, configured limits, input bytes, median parsing/projection/workspace/roundtrip durations, heap deltas, and cancellation latency. It uses actual loopback HTTP byte transport behind the production HTTPS/host grant checks; TLS and remote network latency are outside this measurement. It verifies preservation of all values, lossless raw row roundtrip, empty imported grants/associations, rejection above the row bound, host denial, and caller cancellation. This is a repeatable budget probe rather than an end-to-end viewer or geometry performance claim.

## Explicit local HTTP endpoints

HTTPS remains the default. For a service on this machine, `--allow-loopback-http` authorizes the endpoint's exact HTTP origin, including its port, for that command only. The separate `--host` grant is still required. This switch takes no value.

```bash
ifc-lite semantic query --endpoint http://127.0.0.1:7878/sparql --host 127.0.0.1 --allow-loopback-http --query query.rq --json
```

Only the literal hosts `localhost`, `127.0.0.1`, and `[::1]` qualify. Suffixes, DNS aliases, alternate IP spellings, and a different port do not share the authorization. Redirects remain denied, and cancellation, timeouts, response limits, and credential checks apply. A portable workspace can retain the endpoint as inert configuration; importing it never authorizes HTTP access.

A relay can use a fixed local HTTP upstream by configuring `loopbackHttpOrigin` alongside its endpoint and exact `grantedHost`. For example, an endpoint `http://127.0.0.1:7878/sparql` requires `loopbackHttpOrigin: "http://127.0.0.1:7878"` and `grantedHost: "127.0.0.1"`. Relay clients continue to use authenticated HTTPS. The client request cannot supply or override the upstream authorization.
