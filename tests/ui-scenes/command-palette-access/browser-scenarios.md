<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# #8947 access R1 browser validation

Status: authored, browser execution UNRUN. This finite representative set is not
ALL-feature acceptance, a substitute for semantic inventory reconciliation, or
proof of the existing unit cases. The unchanged #8946 general UX spec has 11
previously accepted scenarios on the earlier source; all 11 must run again on
the candidate alongside these ten access scenarios and the installed-extension scenario.

| Access case | Context | Observable contract |
| --- | --- | --- |
| Refusal and Settings (2) | unloaded desktop/light and narrow/dark | Hide has a described reason, clicking it keeps palette open; keyboard Privacy and Display requests select actual tabs; privacy switch changes |
| Open and Add (2) | desktop keyboard and narrow pointer | actual native filechooser event for each command, multi-file IFC accept; cancel without substituted files |
| Quick search (2) | desktop/light and narrow/dark | native Tab/Space/Enter, parsed-model selection cycling, recent query reuse/clear, advanced Filter, colorful theme on/off |
| Loaded tools (1) | bundled building-architecture IFC, desktop/light, unselected then selected | disabled Hide becomes executable with canonical selection; resident real wall hidden in renderer visibility; Bulk target-source UI, class switch, Angle toolbar, Point/List/Qty tabs |
| Blank (1) | empty desktop/light with real WebGPU | canonical parser creates project/storey; actual Model wall rail pressed and wall.place session; replacement refused |
| Camera (1) | real IFC desktop/light | edge/corner/edge changes actual renderer view-projection; returning to edge reproduces matrix after animation settles |
| Installed extension (1) | real IFC desktop/light | actual .iflx import and grants, owner-qualified dock, QuickJS Hide/Show, UI disable/re-enable/uninstall retirement |
| Live context (1) | real IFC narrow/dark | production role gate observes viewer role while palette open; editor restoration reenables; canonical removeModel retirement disables author destination |

The original access context setup selects an entity from the parsed IFC and invokes the canonical
selection actions. Role setup changes only role data through Zustand; no action,
canCollabEdit function, geometry, host, or action return is replaced. Model
retirement uses the real removeModel action. This does not certify relay role
transport, extension-owner retirement or deferred same-frame races. Narrow
390×844 is a real responsive browser UI, not certification of a phone OS picker,
virtual keyboard, touch gestures or mobile browser chrome.

Each case records uncaught pageerrors and a final actual-state PNG through
Playwright attachments, including on failure. Loaded tools and camera also attach
intermediate actual states. Use a JSON reporter and retain its attachments or
extract the PNGs plus compact status/error summaries; the default list reporter
does not publish passed attachment bodies. Retain failure traces. Missing bundled
sample or missing debug hooks fails honestly; no synthetic fallback is provided.

## Installed extension witness: authored / runtime UNRUN

`tests/e2e/command-palette-access-extension.e2e.spec.ts` adds one finite browser
journey for #8947. Source lives under `tests/e2e/fixtures/palette-access-extension/`:
a manifest, a real widget with Hide/Show buttons and boolean command arguments,
and a plain `async function run(ctx)` handler (the canonical source wrapper does
not accept ESM exports). It reads `bim.query.selection()` and calls
`bim.viewer.hide` / `show`. Consent grants `model.read`, `viewer.read` and
`viewer.isolate`; no host, command result or contribution registry is substituted.

The helper dynamically imports the canonical **built** extension directory loader
and `.iflx` packer. Root pnpm/Turbo must build those outputs first. Discovery never
packs, loads the host or launches a browser. On execution, it validates the source
bundle, packs twice to require identical bytes, and attaches the actual uploaded
`.iflx` plus its byte length/SHA256. No packed hash is claimed before that run.
Do not substitute source imports or an ad-hoc gzip envelope for a missing build.

The test loads the real bundled `building-architecture.ifc`, selects a parsed
wall with canonical selection actions and requires resident scene geometry. It
opens Extensions from the palette, clicks Import, uploads the actual packed bytes
through its filechooser, and explicitly toggles each consent grant off/on before
Install. **ExtensionsPanel always uses `<input type="file" accept=".iflx">`; it
does not use `showOpenFilePicker`.** This test leaves File System Access intact.
In-memory file payloads avoid WSL path interpretation by Windows Chrome over CDP.
This certifies neither the model File System Access picker nor persistent handles.

The exact owner-qualified `ext-widget:` tuple row must open the actual widget in
its dialog. Clicking Hide and Show there dispatches the real owner-scoped command
through QuickJS. Visibility-input assertions must hide then show the resident wall. Independently, the
wall is isolated and framed with canonical controls; completed production GPU color
readbacks must change on Hide and restore on Show with an unchanged camera,
above repeated-frame noise. The hidden output must also agree with an independent wall-absent GPU reference
captured using model-level visibility at the same camera. Highlight removal
alone cannot satisfy that reference. This negative oracle still requires execution. It
then disables the owner through its installed-list switch, requires its destination
to disappear, and presses Enter on the empty owner search to verify no widget opens or
wall is hidden. Re-enabling must restore the destination and widget and execute Hide/Show again,
including the same GPU output/restoration assertions and caught-command-error checks. Finally,
Uninstall plus the real confirmation dialog must remove the installed row and
retire/refuse the destination again. This is observed UI lifecycle retirement,
not certification of a retained DOM callback race in the same frame.

Attachments include consent, hidden/shown wall, disabled/uninstalled owner,
final state, bundle identity/bytes and uncaught pageerrors, including final-state
and pageerror evidence on failure. Retain JSON reporter attachments and failure
traces. **Packing, installation, QuickJS, renderer assertions, screenshots and
retirement remain UNRUN by this author.** Discovery/syntax are not acceptance.

## Coordinator runner recipe (no execution by this author)

First reconcile original receipts in the private coordinator checkpoint; do not
resubmit unknown outcomes. Build and validate matching candidate source through
fleet admission, using the existing root entry point:

```sh
~/build-workers/ifc-fleet run --cwd "$PWD" --cpu 4 --memory 24 \
  --storage-task "$ACCESS_TASK" -- bash tests/ui-scenes/command-palette-access/validate-candidate.sh
```

That script retains root pnpm typecheck, build:e2e and all four root viewer test
shards; these focused browser cases do not replace it. Record source SHA/tree,
built dist index SHA256, artifact receipt and toolchain. Reconcile every shard's
coverage and skips. No acceptance may be claimed from discovery alone.

Discovery only (no server or browser):

```sh
pnpm exec playwright test --project=viewer-e2e-ci --list \
  tests/e2e/command-palette-ux.e2e.spec.ts tests/e2e/command-palette-access.e2e.spec.ts \
  tests/e2e/command-palette-access-extension.e2e.spec.ts
```

Expect 22 tests (11 frozen UX + 10 access + 1 extension). The portable runner
below replaces the machine-specific scratch preload recipe. It does not build,
install dependencies, enter admission, modify specs or change assertions.
Browser execution and physical GPU qualification remain **UNRUN** by its author.
Access R2 remains **UNACCEPTED** until the coordinator runs and reviews it.

### Portable runner: matching root artifacts required

Use the root validation script above first. Reconcile its original receipt,
including failures and skips; never replay a queued/unknown job. On the execution
host, provide a JSON build receipt with these fields, transcribed from the actual
successful root build and linked validation evidence:

```json
{
  "sourceSha": "FULL_40_CHARACTER_SOURCE_SHA",
  "sourceTree": "GIT_HEAD_TREE",
  "command": ["pnpm", "build:e2e"],
  "exit": 0,
  "dist": "/absolute/current-workspace/apps/viewer/dist",
  "distIndexSha256": "SHA256_OF_ACTUAL_INDEX_HTML",
  "rootValidationReceipt": "/absolute/original/root-validation-receipt.json"
}
```

This is a checked evidence link, not proof inferred from a filename: preserve the
original receipt/logs establishing that the root build produced this artifact.
The runner checks the exact expected SHA against Git HEAD, tree, actual dist path
and index bytes against this receipt, and hashes both receipts. It records the
observed worktree/diff and rejects unrelated dirty files. Commit the candidate
before building; only these runner/setup documentation files may be dirty.
The runner does not interpret the entire fleet receipt schema or certify the
root validation gates. An external `--dist` is allowed only with the same matching
receipt checks; never borrow an older similarly named artifact.

Run inside **one** existing `ifc-gpu-check` invocation. If already inside the
helper, execute only the `node ...` command; never nest admission. Use `--limit 30`
or `--limit 60` for bounded untimed correctness, not benchmarks. Choose a new
absolute evidence directory outside the checkout (the runner creates it
exclusively). Root dependencies and built extension packer/loader must exist.

```sh
~/build-workers/ifc-gpu-check --limit 60 -- \
  node tests/ui-scenes/command-palette-access/run-browser.mjs \
  --expected-source "$ACCESS_SOURCE" --build-receipt "$ACCESS_BUILD_RECEIPT" \
  --out "$ACCESS_EVIDENCE" --mode all
```

Modes `e2e`, `matrix`, `contexts`, and `flows` can run separately with different
owned output directories so the coordinator can inspect failures before the next
step. `all` runs in that order and stops on the first failed required step. A
capture process retains its existing per-scene behavior, including recording its
own failures. Neither a failed step nor an omitted mode counts as acceptance.

On PC, the runner uses helper-provided `IFC_GPU_CDP_URL`. It disconnects clients;
the helper retains browser ownership. On Pop without that URL, it starts its own
persistent Linux browser/profile with CDP port zero, reads DevToolsActivePort,
and removes only that profile after closing its owner context. It discovers the
newest executable under `$HOME/.t3/tools/chrome-headless-shell/linux64/*/`, or
accepts `--chrome /absolute/executable` / `IFC_GPU_CHROME_PATH`. Helper-provided
`IFC_GPU_CHROME_ARGS` is required (whitespace-separated flags or a JSON array);
software-renderer and profile/CDP-ownership overrides are rejected. A secure
loopback-origin probe checks the actual adapter information, non-fallback status
and GPU green-pixel readback before acceptance starts. This must succeed on the
coordinator's actual host before reporting physical GPU success.

`attach-gpu.mjs` resolves this checkout's Playwright and redirects the unchanged
UX spec's `chromium.launch` to the exact CDP endpoint. The runner appends this
preload to inherited `NODE_OPTIONS`. In installed Playwright 1.64, CDP
`browser.close()` closes the connection transport; it does not terminate the
helper browser. No existing scratch helper or hardcoded PC checkout is used.

The temporary Playwright config imports the root config, keeps `viewer-e2e-ci`,
uses workers=1 and the JSON reporter, preserves attachments/failure traces, and
lets Playwright own preview startup/teardown. It selects an unused port, enforces
`--strictPort` and `reuseExistingServer: false`, and serves the exact receipt's
dist. A port race fails instead of borrowing a foreign server. Capture commands
use their unchanged strict-port preview lifecycle and receive explicit `--cdp`
on both hosts. No build graph is invoked by the runner.

Retain `manifest.json`, `e2e.json`, `test-results/`, command logs, and each capture
subdirectory. The compact runner manifest records host, observed source/tree/diff,
artifact/receipt hashes, adapter proof, argv/exits, all test outcomes/attachments,
skips, completed modes, not-run modes and partial failure. Exactly 22 passing
cases without skips and 12 exact scene/theme pairs in each requested capture mode
are required. A discovery or syntax pass is not a browser acceptance result.

## Frozen comparisons and new flow captures

Keep the existing six access-context scenes and six general UX matrix scenes
unchanged. Run their existing capture-contexts.mjs and
../command-palette/capture-matrix.mjs recipes on the exact candidate. For the
six access contexts select access-unloaded-hide,access-loaded-hide,
access-selected-hide,access-selected-hide-run,access-history,
access-settings-privacy. Existing baseline assets remain immutable.

New capture-flows.mjs appends six uniquely named flows and then imports the
unchanged capture-contexts entry point. The shared capture protocol saves its
usual manifest with hashes, adapter, layout and pageerrors. Flow observations
add actual destination outcomes. `.actual.png` files are captured *inside* each
flow before common capture.mjs re-homes the model, so the camera corner witness
is not mistaken for the final re-homed screenshot.

```sh
# Inside the coordinator's single managed GPU session; no extra browser launcher.
node tests/ui-scenes/command-palette-access/capture-flows.mjs \
  --dist "$ACCESS_DIST" --out "$ACCESS_EVIDENCE" --label "$ACCESS_SOURCE" \
  --cdp "$IFC_GPU_CDP_URL" --themes light,dark \
  --scenes flow-settings-privacy,flow-narrow-display,flow-hidden-wall,flow-measure-quantities,flow-blank-wall,flow-camera-corner
```

Review actual-state PNGs and pageerrors with Opus. A completed capture is evidence,
not an access verdict. Publish compact results separately, stop only owned
servers/tabs, reconcile receipts and close the owning storage task after all
consumers finish. Preserve source, model fixtures, baseline and foreign work;
release regenerable builds through the managed lifecycle.

Coordinator correction: camera IDs use canonical face order (`front-right-top`).
Native chooser cases deliberately remove the Chromium-only File System Access
capability before startup and exercise the real `<input type="file">` fallback.
They do not replace picker callbacks or model loading. These cases cannot certify
`showOpenFilePicker`, persistent handles, or Refresh; that Chromium-specific path
requires separate observed browser evidence.

Fresh Astra witness objections addressed in source: post-enable command execution
and completed-frame color evidence. These strengthened assertions remain UNRUN.
They do not prove withheld-consent enforcement or same-frame stale callback rejection.

Two additional desktop/light and narrow/dark journeys cover search:inline from
the actual palette, native Tab/Space/Enter, real model selection cycling, recent
query reuse/clear, advanced Filter and pref:colorful on/off. Both remain UNRUN.

When using a managed built checkout that still has an original validation owner,
keep its source untouched. Run these three runner files from a separate owned
helper directory and pass `--checkout /absolute/managed/checkout`. The checkout's
HEAD/tree must match the recorded root build; runner file hashes and location are
recorded independently. This allows read-only browser evidence after the build
phase while full tests continue, without copying new source into an active job.
The helper directory still needs access to this toolchain's installed Playwright;
use the registered workspace dependency, never install a second version ad hoc.
The generated Playwright preview explicitly uses the checkout as its cwd.

The active root protocol writes its known `.palette-access-validation` log files.
The runner records that exact finite output set separately from dirty source;
unrelated untracked or modified source still refuses execution. These logs are
not interpreted as a pass merely because their filenames exist.
