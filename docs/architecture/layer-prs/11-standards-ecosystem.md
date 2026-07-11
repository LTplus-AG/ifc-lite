# 11: Standards and Ecosystem Strategy

## 11.1 IFCX conformance posture

Every published layer is a valid IFCX document; `ifclite::` is one extension namespace (manifest, tombstones). Composition without the namespace degrades gracefully except deletions, hence `bake` (09). Nothing in the system requires a fork of IFCX.

## 11.2 buildingSMART path (the actual star)

Sequence, using the existing paid IFCX panel engagement (Evandro) and the geometry-tiers collaboration (Thomas):

1. Publish the spec set (02-05) implementation-neutral in the repo; reference implementation = IFClite
2. Bring **deletion overlays** to the panel first: smallest, most obviously-missing piece, already acknowledged as future work in IFClite's own code, and a need any layered-IFCX tool will hit
3. Bring **changeset + provenance manifest** second, framed as "interchange of model changes" (the MVD-vs-IDS lesson: standardize the artifact, not the workflow)
4. Feed the **derived-tier merge rule** (05 §5.6) into the geometry-tiers branch as a consuming use case: merge correctness is a strong argument for the P/B/M separation
5. Target: an official IFCX changeset/provenance part with IFClite as reference implementation. The position "proposer with working code and benchmarks" is the strongest one available in standards bodies

## 11.3 Ecosystem integrations (priority order)

| Partner | Integration | Why |
|---|---|---|
| **Motif** | Their native IFC import (current SOW) emits base layers; their edits emit layers; their UI embeds the review viewer via `@ifc-lite/embed-sdk` | Turns the SOW relationship into platform adoption; their ex-Autodesk enterprise buyers are exactly who pays for audit |
| **IfcOpenShell / Bonsai (Dion)** | A python writer emitting layer changesets; Bonsai as a desktop authoring client publishing to the registry | Instantly cross-ecosystem; fits the already-discussed IFClite-as-web-viewer collaboration |
| **buildingSMART validation svc** | Their checks as registry check providers | Required-checks credibility |
| **Lignum / DBL / GS1 (Hansueli, Thomas G.)** | Manufacturer DPP data as signed vendor layers | The Porto "last mile" talk, productized |
| **BFH** | Courses on the public registry; thesis topics (heuristic identity suggestions, merge UX studies) | Pipeline + research credibility |

## 11.4 Competitive positioning

- **Speckle**: versions object streams; no IFCX, no layer composition, no agent provenance, no capability scoping, no required checks. They version data; this versions *intent under policy*
- **ThatOpen/Fragments**: display-oriented, no change model
- **Autodesk/Nemetschek**: will need an agent-safety answer within ~18 months; an existing open standard with a reference implementation forces adopt-or-visibly-reject
- Moat ordering: (1) standards position, (2) working merge engine + benchmarks, (3) registry network effects. Speed on (2) buys time to land (1)

## 11.5 Narrative assets

Benchmark posts ("merge in under a second, in the browser"), the agent fire-safety demo video, a "No agent writes to main" manifesto post, bcftimemachine.com relaunch on the layer DAG, conference talk (next bSI summit): "Pull Requests for Buildings".
