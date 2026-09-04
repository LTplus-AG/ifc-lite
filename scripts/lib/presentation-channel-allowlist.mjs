/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The DATA half of `scripts/check-isolate-expansion-routing.mjs` (#3338): which
 * store actions are policed, which files are known channels, and the reason
 * recorded against each exemption.
 *
 * Split out of the gate when widening it from the two isolation actions to
 * hide/show/colour tripled the allowlist prose and pushed the single file past
 * its module-size budget. The gate keeps the LOGIC (how a call site is
 * classified); this file keeps the JUDGEMENTS (which call sites are fine, and
 * why) -- the half a reviewer actually has to read and check, and the half
 * that grows every time a channel is added.
 */

/**
 * Every store action this gate polices, and which channel kind it actuates.
 *
 * Isolation was the whole list until #3338 routed the SIBLING channels. That
 * was the wrong boundary and the gate's own history says so: it watched
 * `isolateEntities` alone until a channel dodged it for free by picking
 * `setIsolatedEntities` (`useEmbedUrlParams.ts`). `hideEntities`,
 * `showEntities` and `updateMeshColors` are the same trap one step further
 * out -- all three write ids the renderer matches against MESH ids, so a
 * geometry-less `IfcElementAssembly` id in any of them is a silent no-op
 * (`hiddenEntities` never matches; a colour lands on nothing), and a NEW file
 * that hides or colours raw user-picked ids was previously invisible here.
 *
 * `setPendingColorUpdates` -- the OTHER colour actuator, used by the lens,
 * IDS, clash, schedule-overlay and SDK channels -- is deliberately NOT in
 * this list yet. It has 31 call sites across 14 files, most of them
 * ownership/restore sequences in subsystems this gate's author has not
 * audited, and adding it without that audit would mean 14 allowlist entries
 * whose reasons are guesses. Stating the gap with its measured size, rather
 * than either silently omitting it or papering it with invented
 * justifications: a channel that actuates colour through
 * `setPendingColorUpdates` can still be added without this gate seeing it.
 */
export const POLICED_ACTIONS = [
  { name: 'isolateEntities', kind: 'isolation' },
  { name: 'setIsolatedEntities', kind: 'isolation' },
  { name: 'hideEntities', kind: 'visibility' },
  { name: 'showEntities', kind: 'visibility' },
  { name: 'updateMeshColors', kind: 'colour' },
];

/**
 * Channels that MUST show a `ROUTING_MARKERS` call in the same file. Paths
 * are repo-relative, forward-slashed.
 */
export const REQUIRES_ROUTING_MARKER = new Set([
  'apps/viewer/src/components/viewer/LensPanel.tsx',
  'apps/viewer/src/components/viewer/PropertiesPanel.tsx',
  'apps/viewer/src/components/viewer/SearchModal.filter.tsx',
  'apps/viewer-embed/src/bridge/handler.ts',
  // A SEVENTH channel found by widening CALL_PATTERN to setIsolatedEntities
  // (a real bug, not hypothetical): `?isolate=` named a geometry-less
  // assembly and blanked the viewport, because this hook calls the
  // ASSIGNING `setIsolatedEntities`, never `isolateEntities` -- invisible to
  // every earlier version of this gate.
  'apps/viewer-embed/src/components/useEmbedUrlParams.ts',
  // Audited alongside the seventh channel (all five other setIsolatedEntities
  // callers, per the review that found #useEmbedUrlParams.ts): a BCF
  // viewpoint's visible-component exceptions can name whatever the
  // AUTHORING tool recorded, not guaranteed geometry-bearing in this
  // renderer.
  'apps/viewer/src/hooks/useBCF.ts',
  // The IDS row-focus isolate (`installFocusIsolation`) and set-level
  // isolate (`installSetIsolation`, the failed/passed/involved buttons):
  // both isolate ids an IDS specification's applicability filter matched,
  // which can be any IFC class, including a geometry-less assembly -- the
  // same shape as LensPanel/SearchModal.filter's rule-matched ids.
  'apps/viewer/src/hooks/useIDS.ts',
  // The SDK/MCP isolate() channel: #3382 landed the routing fix and #3338
  // moved its union policy into the shared `resolvePresentationIds`, so this
  // now genuinely routes and belongs here instead of NO_MARKER_REQUIRED.
  'apps/viewer/src/sdk/adapters/visibility-adapter.ts',
]);

/**
 * Channels that call `isolateEntities(` but are not required to show a
 * `ROUTING_MARKERS` call, each with a reason a reviewer can check.
 */
export const NO_MARKER_REQUIRED = new Map([
  [
    'apps/viewer/src/components/viewer/HierarchyPanel.tsx',
    "isolates ids from getNodeElements()/node.globalIds, which treeDataBuilder.ts already " +
    'resolved to geometry-bearing members at tree-build time via hasAggregatedGeometry / ' +
    'collectAggregatedDescendants (issue #1133) -- a different, non-renderer-dependent path ' +
    'to the same correctness property, not a raw ref. The same getNodeElements() ids drive this ' +
    "file's hideEntities/showEntities visibility toggle, so they are covered by the same " +
    'argument.',
  ],
  [
    'apps/viewer/src/hooks/useClash.ts',
    'installClashIsolation only ever receives a clash PAIR\'s element refs (clash.a.ref / ' +
    'clash.b.ref), and clash detection tests actual mesh triangles for intersection -- an ' +
    'element without geometry can never appear in a clash result, so these ids are always ' +
    'geometry-bearing by construction, not a raw user pick that needs expansion.',
  ],
  [
    'apps/viewer/src/components/viewer/anonymized-export/usePreviewIsolation.ts',
    "the 3D preview's contract is to MIRROR the export's `includedIds` exactly, not to isolate " +
    'what a user picked -- a geometry-less container in that set draws nothing because the export ' +
    'genuinely contains no geometry for it, which is the truth the preview is there to show. ' +
    "Expanding it would be inert under the shipped defaults (`related-entities.ts` walks " +
    "`IfcRelAggregates` 'both', so an included container's renderable parts are already in the " +
    'set) and actively wrong when the user turns that walk off or unchecks a part: the preview ' +
    'would then show geometry the exported file does not contain.',
  ],
  [
    'apps/viewer/src/lib/tours/tours/ids.ts',
    'the tour cleanup only ever calls setIsolatedEntities(null) to release an isolation the ' +
    'tour installed elsewhere -- null clears the channel and has nothing to expand, and this ' +
    'file never installs a non-null set of its own.',
  ],
  [
    'apps/viewer/src/components/viewer/CommandPalette.tsx',
    'The "Hide Selection" command hides THE CURRENT SELECTION (state.selectedEntityIds, falling back to selectedEntityId), not a raw entity pick. Selecting a geometry-less assembly already puts its renderable parts in that set: useSelectAssembly.ts does setSelectedEntityIds([...renderableParts, globalId]) after routing through cameraCallbacks.resolveHighlightIds, and SearchModal.text/HierarchyPanel do the same, so the ids arriving here are post-expansion. Expanding again would be a no-op at best.',
  ],
  [
    'apps/viewer/src/components/viewer/MainToolbar.tsx',
    'The toolbar Hide button hides THE CURRENT SELECTION (state.selectedEntityIds, falling back to selectedEntityId), not a raw entity pick. Selecting a geometry-less assembly already puts its renderable parts in that set: useSelectAssembly.ts does setSelectedEntityIds([...renderableParts, globalId]) after routing through cameraCallbacks.resolveHighlightIds, and SearchModal.text/HierarchyPanel do the same, so the ids arriving here are post-expansion. Expanding again would be a no-op at best.',
  ],
  [
    'apps/viewer/src/components/viewer/ribbon/tabs/ElementsTab.tsx',
    'The Elements ribbon Hide button hides THE CURRENT SELECTION (state.selectedEntityIds, falling back to selectedEntityId), not a raw entity pick. Selecting a geometry-less assembly already puts its renderable parts in that set: useSelectAssembly.ts does setSelectedEntityIds([...renderableParts, globalId]) after routing through cameraCallbacks.resolveHighlightIds, and SearchModal.text/HierarchyPanel do the same, so the ids arriving here are post-expansion. Expanding again would be a no-op at best.',
  ],
  [
    'apps/viewer/src/hooks/useKeyboardShortcuts.ts',
    'Delete/Backspace/Space hide via getAllSelectedGlobalIds(), which hides THE CURRENT SELECTION (state.selectedEntityIds, falling back to selectedEntityId), not a raw entity pick. Selecting a geometry-less assembly already puts its renderable parts in that set: useSelectAssembly.ts does setSelectedEntityIds([...renderableParts, globalId]) after routing through cameraCallbacks.resolveHighlightIds, and SearchModal.text/HierarchyPanel do the same, so the ids arriving here are post-expansion. Expanding again would be a no-op at best.',
  ],
  [
    'apps/viewer/src/components/viewer/MobileToolbar.tsx',
    'KNOWN GAP, tracked on #3338, not a justification: unlike its four siblings this one hides ' +
    '[selectedEntityId] -- the SINGULAR id -- rather than the selectedEntityIds set that carries ' +
    "an assembly's expanded parts, so hiding a selected geometry-less assembly on mobile hides " +
    'nothing. Routing it means deciding whether the mobile Hide should follow the selection set ' +
    'like MainToolbar does, which is a behaviour change with its own test, not a drive-by here.',
  ],
  [
    'apps/viewer/src/components/viewer/schedule/useOverlayCompositor.ts',
    'A two-sided OWNERSHIP LEDGER, not a user pick: it hides the ids the composed schedule ' +
    'overlay layers ask for, records per id whether the user was already hiding it, and shows ' +
    'back exactly the ids it hid. Both halves must name the same set or the ledger stops ' +
    'matching and teardown unhides something the user hid; expanding one side and not the other ' +
    'is precisely how that breaks. The ids come from schedule task element sets, not from a ' +
    'raw ref a user clicked.',
  ],
  [
    'apps/viewer/src/hooks/useCompareOverlay.ts',
    'The same two-sided ownership ledger as the schedule overlay compositor above ' +
    '(reconcileHidden / restoreOwnedHidden), over compare-diff element sets rather than a user ' +
    'pick. Its showEntities calls release ids this module itself hid, so they must name that ' +
    'exact set.',
  ],
  [
    'apps/viewer/src/components/viewer/useGeometryStreaming.ts',
    'NAME COLLISION, not a channel: the only match is scene.updateMeshColors(...), a method on ' +
    "the RENDERER's scene object that uploads a colour buffer to the GPU, not the viewer store " +
    'action of the same name. It takes a device and a pipeline as its second and third ' +
    'arguments, which the store action does not have.',
  ],
  [
    'apps/viewer/src/hooks/useIfcLoader.ts',
    'Applies cumulativeColorUpdates accumulated DURING parsing/streaming -- colours the loader ' +
    'computed per mesh as the meshes themselves arrived, keyed by ids that by construction own a ' +
    'mesh. Nothing here originates from an entity a user or a host script named.',
  ],
  [
    'apps/viewer/src/store/slices/mutationSlice.ts',
    'Hides the mesh of the ONE entity a delete-entity mutation just removed, by the express id ' +
    'that was deleted. Expanding it to an aggregated subtree would hide parts the mutation did ' +
    'not delete, and the undo branch shows back the same single id, so the two halves must ' +
    'agree.',
  ],
  [
    'apps/viewer/src/store/slices/collabSlice.ts',
    "The peer-delete handler: hides the single entity a collaborator's onEntityDelete event " +
    'names. Same reasoning as mutationSlice above -- the parts of a deleted assembly were not ' +
    'themselves deleted, so expanding would hide geometry that is still in the model.',
  ],
  [
    'apps/viewer/src/store/slices/visibilitySlice.ts',
    'this IS the definition site of both isolateEntities and setIsolatedEntities (the actions ' +
    'this gate polices, not a caller of them) -- the only textual match is a doc comment ' +
    'describing another channel\'s restore sequence ("... went setIsolatedEntities(null) ..."), ' +
    'and the file itself never installs a raw id set into a resolver-dependent channel.',
  ],
]);

/**
 * MIXED files: listed in `REQUIRES_ROUTING_MARKER` for one channel kind while
 * a DIFFERENT policed action in the same file legitimately does not route, or
 * is a known-unrouted gap being tracked rather than silently passed. Keyed by
 * path, then by action name, each with its own reason.
 *
 * This exists because routing is now checked PER CALL SITE (see
 * `unroutedCallSites`): a file-level "this file is fine" verdict cannot say
 * "the isolate here is routed but the hide is not", and that is exactly the
 * state `LensPanel.tsx` is in.
 */
export const EXEMPT_ACTIONS = new Map([
  [
    'apps/viewer/src/components/viewer/LensPanel.tsx',
    new Map([
      [
        'hideEntities',
        'KNOWN GAP, tracked on #3338, not a justification: the lens hidden-id sync writes ' +
        'planLensHiddenSync deltas over state.lensHiddenIds, which are LENS RULE MATCHES and can ' +
        'name a geometry-less IfcElementAssembly exactly as the rule ISOLATE above can -- so this ' +
        'hide is a silent no-op for that case. Left unrouted here deliberately: hide and show are ' +
        'two halves of an ownership ledger (lensAppliedHiddenIds records what the lens hid so ' +
        'teardown releases only that), and expanding one side without the other corrupts it. ' +
        'Routing both is a behaviour change that needs its own test, not a drive-by.',
      ],
      [
        'showEntities',
        'The release half of the hideEntities ledger above -- it must pass back exactly the ids ' +
        'planLensHiddenSync says the lens owns, so expanding here would release ids the lens ' +
        'never hid and unhide something the user hid themselves.',
      ],
    ]),
  ],
]);

/** Anti-vacuity floor: fewer total call sites than this means the detection
 *  regex broke (renamed action, moved directory), not that channels vanished.
 *  Raised from 6 to 13 when `SET_ISOLATED_CALL_PATTERN` widened the scan to
 *  `setIsolatedEntities` (seven new real candidates: the seventh channel
 *  itself plus the six audited direct callers) -- the real tree scans clean
 *  at 13 as of this change; lower it only after confirming channels were
 *  deliberately removed, never just because the count dropped.
 *  Raised from 12 to 23 when `POLICED_ACTIONS` widened the scan from the two
 *  isolation actions to `hideEntities`, `showEntities` and `updateMeshColors`
 *  as well: eleven new candidate files, every one of them a real hide/colour
 *  call site that this gate could not see before (listed individually in
 *  `NO_MARKER_REQUIRED` below, two of them as tracked gaps rather than
 *  justifications).
 *  Previously lowered from 13 to 12 when `classifyFile` started scanning
 *  `stripCommentsAndStrings(content)` instead of raw source: this floor's OWN
 *  NO_MARKER_REQUIRED entry for `visibilitySlice.ts` already documented that
 *  "the only textual match is a doc comment" there (a `setIsolatedEntities(
 *  null)` mention describing a DIFFERENT channel's restore sequence, not a
 *  call in this file). Stripping comments correctly removes that false
 *  candidate rather than a real channel disappearing -- confirmed by rereading
 *  the file, not by the count alone. */
export const CANDIDATE_FLOOR = 23;

