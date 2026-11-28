# Layer Stack

An IFC5 (IFCX) model can be composed from several files, each a **layer** that adds to or overrides the layers below it. The **Layer stack** panel shows that composition, who wrote each layer, what each layer changes, and lets you publish your own edits as a new layer and merge layers into a ref. Open it from the **Check** group of the panel rail. A deployment can switch it off with the `data.layers` feature (see [Configuring a Deployment](./viewer-deployment-config.md)).

The same layer model is available on the command line as `ifc-lite layer` (see [CLI Toolkit](./cli.md)). [Layer PRs](../architecture/layer-prs/index.md) describes the design.

## Loading a stack

- **Open .ifcx files** loads several IFCX files at once as one stack. Dropping several `.ifcx` files anywhere in the viewer does the same. [Federation](./federation.md#ifc5-federated-layers) describes the composition rules.
- **Load demo stack** loads the buildingSMART hello-wall sample with two extra layers: an agent's fire-safety pass with check evidence, and a human review that overrides it. It is offered only when the `files.samples` feature is on.

## Reading the stack

The panel lists the layers strongest first: a layer overrides the ones below it. Each row shows the layer's position, name, intent, author, date and node count:

- The author badge is **Human**, **Agent** or **Hybrid** for a layer with a provenance manifest, or **unsigned** for raw IFCX (an import or a foreign file).
- A merge icon marks a merge layer. A checks badge shows how many attached checks pass.
- Click a row to show its provenance: author, intent, creation date, base, scope, checks, merge details, content-derived identities and signatures. A malformed manifest is reported, and the layer is treated as unsigned.
- With a collaboration server configured, a check entry can fetch its evidence report from the server's layer registry. For an IDS report it lists the failing entities (up to 50); click one to select it in 3D, or download the raw report.

## Seeing what a layer changes

**Changes** on a layer compares the layers below it with and without it and lists the entities it added, modified and deleted. Filter by kind, click an entity to select it, and use **Ghost others** to fade everything the layer does not touch. The list shows the first 200 changes.

## Publishing edits as a layer

Edit properties of the composed model as usual (see [Mutations](./mutations.md)). The **Draft layer** section counts the pending edits. Enter an **Intent** (required) and an **Author**, then **Publish**:

- The edits become a new content-addressed layer on the browser's local ref `local`, and the layer is stacked on top.
- Edits to entities without a stable identity, or with no layer representation, stay out of the layer. The layer is still published to `local`, but it is not stacked, and the pending edits are kept.
- In a live collaboration session, **Publish session edits** freezes the session's edits since joining (or since the last publish). When other peers have been in the session since then, the author kind is **Hybrid**.

Published layers and refs are stored in the browser's IndexedDB, so they survive a reload. Without IndexedDB they last only for the session.

## Merging

The **Merge** section appears once the browser store holds a layer, even before a stack is loaded:

1. Pick a **Candidate layer** and a **Target ref**. Targets are the local refs and, when a collaboration server is configured, the refs of its layer registry.
2. **Preview** shows how many changes merge automatically and how many conflict, and lists the ref's required checks. When the ref has no shared base with the candidate, a warning says so.
3. Decide each conflict: **ours**, **theirs**, or **edit** (a JSON object of replacement attributes). **all ours** and **all theirs** decide every conflict at once. A failing required check needs a waiver with a reason; the reason is recorded in the merge manifest.
4. **Merge** (or **Merge with resolutions**) fast-forwards the ref or writes a merge layer. A ref policy can still refuse it.
5. For a local ref, **Load merged ref** loads the merged stack.

## Reviewing on a registry

With a registry ref as the target, the **Review** section opens a review of the candidate against that ref (**Open review**). Select an entity in 3D to comment on it, with an optional description and the current viewpoint. **.bcf** exports the review's comments as a BCF file.

The registry is the collaboration server's layer registry. It needs a collaboration server URL in the viewer (`VITE_COLLAB_SERVER_URL` at build time) and `COLLAB_LAYER_REGISTRY=1` on the server (see [Collaboration Server](./collab-server.md) and [Environment Variables](./environment-variables.md#collaboration-server)).
