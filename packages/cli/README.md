# @ifc-lite/cli

BIM toolkit for the terminal. The `ifc-lite` command reads, queries, validates, exports, creates, merges, converts, and diffs IFC files, and can script them with the `bim.*` SDK. Output is pipe-friendly and every command supports `--json` for machine-readable results, which makes it a good fit for both humans and LLM terminals.

## Install

```bash
npm install -g @ifc-lite/cli
```

## Usage

```bash
ifc-lite info model.ifc
ifc-lite query model.ifc --type IfcWall --json
ifc-lite props model.ifc --id 42
ifc-lite export model.ifc --format csv --type IfcWall --columns Name,Type,GlobalId
ifc-lite create wall --height 3 --thickness 0.2 --start 0,0,0 --end 5,0,0 --out wall.ifc
ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
ifc-lite eval tests/models/cost/buildingsmart-cost-composition.ifc "bim.cost.evaluateItem({modelId:'default',expressId:42})" --json
ifc-lite view model.ifc
```

The cost command above uses the canonical fixture at the shown path (fetch it
with `pnpm fixtures`); express ID 42 is its `External wall total` cost item.

`bim.cost` reads the loaded IFC source snapshot and returns decimal strings;
pending generic mutation overlays are not included until reload.

## Opening models from OCI registries

Commands that read an IFC model (all but `view` and the IFCX `layer`/`ref`
store) also accept an `oci://` reference to an artifact in an OCI registry
(GHCR, ECR Public, Harbor, `distribution`, ...):

```bash
ifc-lite info oci://ghcr.io/acme/tower-model:rev-b
ifc-lite diff --json oci://ghcr.io/acme/tower-model:rev-a oci://ghcr.io/acme/tower-model:rev-b
ifc-lite query oci://ghcr.io/acme/tower-model@sha256:<64 hex> --type IfcWall --count
```

- References are `oci://host[:port]/repository[:tag][@sha256:<hex>]`; the host
  is always named (there is no default registry).
- `localhost`, `127.0.0.1` and `[::1]` (any port) are reached over plain
  `http`; every other host over `https`.
- Credentials come from the environment only, never from Docker config or an
  implicit `GITHUB_TOKEN`: `IFC_LITE_OCI_USERNAME` with `IFC_LITE_OCI_PASSWORD`,
  or `IFC_LITE_OCI_TOKEN` (a registry bearer token). Set one form, not both.
  Without either the pull is anonymous.
- The model layer is capped at 1 GiB; `IFC_LITE_OCI_MAX_BYTES` (a positive
  integer number of bytes) changes the cap. The download is verified against
  its sha256 digest.
- Layer choice: a manifest with one layer uses it. Otherwise exactly one layer
  must have media type `application/x-step` or an
  `org.opencontainers.image.title` ending in `.ifc` / `.ifczip`; anything else
  fails with the list of layers. An index (multi-manifest) reference fails with
  its entries; pin one by digest. The artifact type is not checked.
- JSON output keeps its shape: the field that carries the file path
  (`info`'s `file`, `diff`'s `file1.path` / `file2.path`) carries the reference.

In GitHub Actions, pulling from GHCR with the workflow token:

```yaml
- run: ifc-lite info --json oci://ghcr.io/acme/tower-model:rev-b
  env:
    IFC_LITE_OCI_USERNAME: ${{ github.actor }}
    IFC_LITE_OCI_PASSWORD: ${{ secrets.GITHUB_TOKEN }}
```

### Publishing a model: `ifc-lite oci push`

```bash
ifc-lite oci push oci://ghcr.io/acme/tower-model:rev-c tower.ifc
# Pushed oci://ghcr.io/acme/tower-model:rev-c → sha256:… (layer sha256:…, 225635 bytes)
ifc-lite oci push oci://ghcr.io/acme/tower-model:rev-c tower.ifc --overwrite --json
ifc-lite oci push oci://localhost:5000/demo/model:v1 model.ifc \
  --annotation org.opencontainers.image.revision=abc123 \
  --annotation org.opencontainers.image.source=https://example.com/repo
```

- The artifact uses the layout the ifc-lite viewer publishes: `artifactType`
  `application/vnd.ifc-lite.ifc.v1`, the OCI empty config (`{}`), and exactly
  one layer of media type `application/x-step` whose
  `org.opencontainers.image.title` is the file name. Blobs are pushed first
  (config, then the layer), then the manifest under the tag.
- Manifest annotations: `org.opencontainers.image.created` (RFC 3339, UTC,
  whole seconds; taken from `SOURCE_DATE_EPOCH` when set, so pushing the same
  file twice gives the same manifest digest), `org.opencontainers.image.title`
  (the file name without its extension), and every `--annotation key=value`.
  The key must be non-empty and on one line; a later duplicate wins;
  `org.opencontainers.image.title` cannot be set this way (rename the file).
- The manifest and the layer carry `org.buildingsmart.ifc.profile`
  (`ifc-release/0`) and `org.buildingsmart.ifc.schema` (from `FILE_SCHEMA`).
  These keys are a provisional convention shared with subsoil, not a
  buildingSMART standard, and may change. They cannot be set with `--annotation`.
- The file is checked before any request with the same content check the
  loader uses (STEP envelope, terminator, DATA section), and its `FILE_SCHEMA`
  must name an IFC schema. `.ifczip` (by name or zip content) is refused:
  only plain IFC-SPF is supported for publishing for now.
- The reference must carry a tag; a digest reference is refused, since the
  digest is computed from the manifest. An existing tag is refused with
  `tag <tag> already exists; pass --overwrite to replace it` (exit 1) unless
  `--overwrite` is given. That check is a request before the write, so it is
  not atomic against another client pushing the same tag at the same moment.
- Credentials and the http/https rule are the same as for `oci://` input;
  push asks the registry for `pull,push` scope. Credentials are never printed.
- `--json` prints only
  `{ "reference", "digest", "layer": { "digest", "size", "mediaType" }, "artifactType" }`
  on stdout; errors go to stderr.

## Installation diagnostics

```bash
ifc-lite doctor
ifc-lite doctor --json > ifclite-diagnostics.json
```

Reports the CLI runtime, resolved versions of its declared first-party dependencies, and WASM binary structure, byte length and SHA-256. It loads no IFC model or geometry module, so it can report damaged package entries. Exit 0 means every reported check passed; exit 1 means a check failed. The report describes this CLI installation. WASM validation checks binary structure without initializing IFC bindings.

## Commands

- `doctor` - runtime, package versions and WASM binary checks

- `info` - model summary: schema, entities, storeys
- `query` - query entities by type, properties, quantities; supports `--sum`, `--group-by`, `--spatial`
- `props` - all properties for a single entity (`--id N`)
- `export` - export to `csv`, `json`, `ifc`, `obj`, `gltf`, `glb`, `jsonld`, `ifcx`, `usd`, `step`, `hbjson`, or `dfjson`
- `ids` - validate against buildingSMART IDS rules
- `validate` - structural validation checks
- `stats` - auto-calculated model KPIs and health check
- `clash` - geometric clash detection, `--matrix`, `--bcf` output
- `bcf` - create and inspect BCF collaboration files
- `create` - create IFC elements from scratch (walls, slabs, stairs, 29 types)
- `mutate` - modify properties or attributes and save
- `merge` - merge multiple IFC files into one federated file
- `convert` - convert between IFC schema versions (`--schema IFC4`)
- `diff` - compare two IFC files
- `rekey` - carry a table keyed on old element keys across a revision
- `eval` / `run` - run SDK expressions or scripts against a model
- `ask` - natural language BIM queries
- `view` - interactive 3D viewer in the browser, controllable via REST (`/api/command`)
- `analyze` - query plus colorize/isolate/heatmap results in the running viewer
- `simplify` - demesher: simplify meshes, write a lighter IFC
- `mcp` - start an MCP server bound to one or more IFC files (stdio or http)
- `layer` - layered change tracking over a local store (`.ifc-lite/`)
- `ref` - manage named refs in the layer store
- `anonymize` - export selected objects + context as an anonymized IFC
- `schedule` - tabular schedule of one class (csv/json/md/html)
- `delivery` - repeatable delivery check (structural + IDS) from a saved recipe
- `gym` - reset/step/reward environment loop over the existing schema/clash/ids checks (see below)
- `schema`, `bsdd`, `diagnose-geometry`, `extract-entities`, `generate-spaces`, `lod`, `ext` - see `ifc-lite --help`

Global flags: `--json`, `--verbose`, `--quiet`, `--debug`, `--log-level <level>`.

## gym

`ifc-lite gym` is a prototype reset/step/reward environment API over the existing headless checks: the skeleton of an RLVR environment for buildings (see [`tools/world-gym/README.md`](../../tools/world-gym/README.md) M2 and [`tools/world-gym/benchmark/BENCHMARK.md`](../../tools/world-gym/benchmark/BENCHMARK.md) B0.4). It wraps a model - either a fixed file (`--model`) or a procedurally generated World Gym episode (`--seed`) - and lets an agent apply data-mutation ops, scoring each step against the same schema/clash/ids checks the `validate`, `clash`, and `ids` commands already run.

```bash
ifc-lite gym --model model.ifc --checks schema,clash
ifc-lite gym --model model.ifc --checks schema,clash,ids --ids rules.ids
ifc-lite gym --seed 42 --checks schema,clash          # generated episode (repo checkout only)
ifc-lite gym --seed 8 --family frame --corrupt --checks schema
```

The protocol is newline-delimited JSON: one JSON object per line, in both directions.

- On start, `gym` prints one line: `{"type":"reset","observation":{...},"channels":{...}}`. `observation` has sorted `entityCounts` (by IFC type), `storeyCount`, and `schema` version. `bounds` is always `null` in v0 (a known gap: no geometry pass runs on `reset`, see below). Generated episodes add an `episode` field: `{seed, family, corrupted}`.
- Send `{"type":"step","ops":[...]}` on stdin to apply ops and score the result. `gym` replies `{"type":"reward","channels":{...},"done":false}`. A step batch is atomic: it either fully applies or (on any malformed op or scoring failure) leaves the session unchanged and replies with an error line.
- Send `{"type":"reset"}` to reload the pristine model; replies like the initial reset.
- Send `{"type":"reset","seed":8}` (optional `family`, `corrupt` OR `corruptRate`) to swap to a fresh generated episode mid-session.
- Send `{"type":"close"}` to exit 0.
- Malformed JSON or an unknown command/op never crashes the process: it replies `{"type":"error","message":"..."}` and keeps reading.

Episode factory: `--seed <n>` generates a deterministic World Gym benchmark model in-process instead of loading a file. `--family frame|office|auto` pins the family; corruption follows the benchmark's deterministic draw at the spec's corrupt rate unless `--corrupt`/`--no-corrupt` forces it or `--corrupt-rate <p>` overrides the rate (forcing and a rate are mutually exclusive). The generator is dynamically imported from a repo checkout (`tools/world-gym/`); the published npm package prints a clear error for `--seed` while `--model` keeps working.

Reward shaping: every channel's `score` is in `[0, 1]` and higher is better. The clash channel scores `1` for a clash-free model and strictly decreases as the clash count grows (the raw count is reported separately as `totalClashes`), so an agent maximizing any channel is never rewarded for making the model worse.

v0 ops mirror `bim.mutate`'s method names exactly: `setProperty`, `setAttribute`, `deleteProperty` (all keyed by `expressId`). Geometry-creating ops (new walls, slabs, etc.) are out of scope for v0.

```json
{"type":"step","ops":[{"op":"setProperty","expressId":42,"psetName":"Pset_WallCommon","propName":"IsExternal","value":true}]}
```

Determinism: the same model plus the same op sequence yields byte-identical reward lines (sorted arrays, no timestamps, fixed-precision floats).

## Durable Flow BCF writes

Flow BCF API creates persist a credential-free intent before sending in
`IFCLITE_BCF_OUTBOX_DIR` (default `~/.ifc-lite/bcf-outbox`). Preserve
this directory across restarts. Unknown outcomes block identical writes until review:

```bash
ifc-lite flow bcf list
ifc-lite flow bcf check <entryId> --allow-host bcf.example.com --token-env BCF_TOKEN
# Only if this read sees the full collection in the original write access scope:
ifc-lite flow bcf check <entryId> --allow-host bcf.example.com --token-env BCF_TOKEN --confirm-full-read-access
ifc-lite flow bcf reconcile <entryId> --guid <checkedGuid>
# Only after a complete empty check with explicitly confirmed full read visibility:
ifc-lite flow bcf confirm-absent <entryId>
```

Check reads the recorded target using a fresh explicit host grant and an environment
variable reference for the token. Review the actual server object before reconciling a
checked candidate. Reconciliation records its GUID durably and never sends a write.
Only an explicitly full-visibility complete empty check permits `confirm-absent`, which releases the
intent for a later deliberate rerun and sends nothing itself. Unavailable or ambiguous
checks do not permit release. Token presence is not proof of visibility: `--confirm-full-read-access` asserts that this authorized read sees the full target collection under the same access scope as the original write. Omit `--token-env` for a genuinely public server; the visibility assertion remains required for absence. The journal retains this proof marker, without storing credential or principal identity. Older markerless absent checks stay readable but require a fresh asserted check before release. Storage errors and secret-bearing payloads refuse the effect.

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0

Semantic datasets use the same shared profile and provider engine as the viewer. Run `ifc-lite semantic --help` for `validate`, `query`, `assets`, and authenticated HTTPS `serve`; see the [headless semantic guide](https://ifclite.dev/docs/guide/semantic-headless/).
