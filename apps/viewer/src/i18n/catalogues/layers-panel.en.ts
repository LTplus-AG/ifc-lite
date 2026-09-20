/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/**
 * The Layers panel (#1717, #4918 layers slice): the layer-stack panel's own
 * chrome (`LayersPanel.tsx`), its draft/publish flow (`LayerDraftSection`),
 * merge flow with conflict resolution (`LayerMergeSection`), registry-review
 * comments (`LayerReviewSection`), per-stratum provenance manifest
 * (`LayerProvenanceDetail`), fetched IDS check evidence
 * (`LayerCheckEvidence`), and the per-layer stack diff (`LayerDiffView`).
 * Layer NAMES, tag NAMES, content-address digests, file/ref names, and IFC
 * GlobalIds/paths remain model or registry runtime data and stay out of the
 * catalogue; only the surrounding chrome is covered here. This is a sibling
 * to the unrelated `merge-layers-banner.en.ts` (the multilayer-wall-merge
 * setting reload banner), not a rename of it.
 */
export const layersPanelEn = {
  // LayerCheckEvidence
  'layersPanel.checkEvidence.loading': 'Fetching evidence…',
  'layersPanel.checkEvidence.offline': 'Connect a collab server to fetch evidence.',
  'layersPanel.checkEvidence.missing': 'Evidence not on the registry (digest stays verifiable).',
  'layersPanel.checkEvidence.summary': {
    one: '{failed}/{total} specs failing, {count} entity failure',
    other: '{failed}/{total} specs failing, {count} entity failures',
  },
  'layersPanel.checkEvidence.notIdsReport': 'Evidence fetched (not an ids report)',
  'layersPanel.checkEvidence.downloadAriaLabel': 'Download evidence report',
  'layersPanel.checkEvidence.downloadLabel': 'raw',
  'layersPanel.checkEvidence.selectTitle': 'Select in 3D',
  'layersPanel.checkEvidence.notInCompositionTitle': 'Not in the current composition',
  'layersPanel.checkEvidence.moreFailures': '…and {count} more (download the raw report).',

  // LayerDiffView
  'layersPanel.diffView.title': 'Changes by {name}',
  'layersPanel.diffView.ghostingOn': 'Ghosting others',
  'layersPanel.diffView.ghostingOff': 'Ghost others',
  'layersPanel.diffView.countAdded': '{count} added',
  'layersPanel.diffView.countModified': '{count} modified',
  'layersPanel.diffView.countDeleted': '{count} deleted',
  'layersPanel.diffView.emptyState': 'This layer changes nothing on top of the stack below it.',
  'layersPanel.diffView.showingCount': 'Showing {shown} of {total} changes.',

  // LayerDraftSection
  'layersPanel.draft.title': 'Draft layer',
  'layersPanel.draft.pendingBadge': { one: '{count} pending edit', other: '{count} pending edits' },
  'layersPanel.draft.emptyPrompt': 'Edit properties in the model, then freeze the changes here as a new layer.',
  'layersPanel.draft.intentPlaceholder': 'Intent, e.g. Set fire ratings for EG walls',
  'layersPanel.draft.authorPlaceholder': 'Author',
  'layersPanel.draft.publishing': 'Publishing…',
  'layersPanel.draft.publish': 'Publish',
  'layersPanel.draft.publishSessionEdits': 'Publish session edits',
  'layersPanel.draft.localRefNote': "Freezes the pending edits as a content-addressed layer on the local ref '{ref}' and stacks it onto the composition.",
  'layersPanel.draft.entityCountPhrase': { one: '{count} edited entity', other: '{count} edited entities' },
  'layersPanel.draft.editCountPhrase': { one: '{count} edit', other: '{count} edits' },
  'layersPanel.draft.publishedPartialUnresolved': "Published to '{ref}', but {entityPhrase} had no stable identity and stayed out. Pending edits were kept; the layer was not stacked.",
  'layersPanel.draft.publishedPartialSkipped': "Published to '{ref}', but {editPhrase} had no layer representation and stayed out. Pending edits were kept; the layer was not stacked.",
  'layersPanel.draft.publishedPartialBoth': "Published to '{ref}', but {entityPhrase} had no stable identity and {editPhrase} had no layer representation, and stayed out. Pending edits were kept; the layer was not stacked.",
  'layersPanel.draft.publishedSuccess': "Published {layerId}… to '{ref}' ({opCount} ops).",
  'layersPanel.draft.publishedSessionSuccess': "Published session draft {layerId}… to '{ref}' ({opCount} ops).",
  'layersPanel.draft.sessionEditsSinceJoining': {
    one: "Freezes the live session's Y.Doc edits since joining — including {count} peer's edits (author kind: hybrid).",
    other: "Freezes the live session's Y.Doc edits since joining — including {count} peers' edits (author kind: hybrid).",
  },
  'layersPanel.draft.sessionEditsSinceLastPublish': "Freezes the live session's Y.Doc edits since the last publish.",

  // LayerMergeSection
  'layersPanel.merge.removed': 'removed',
  'layersPanel.merge.checkPassAriaLabel': 'pass',
  'layersPanel.merge.checkFailAriaLabel': 'fail',
  'layersPanel.merge.oursOption': 'ours',
  'layersPanel.merge.theirsOption': 'theirs',
  'layersPanel.merge.editOption': 'edit',
  'layersPanel.merge.oursValue': 'ours: {value}',
  'layersPanel.merge.theirsValue': 'theirs: {value}',
  'layersPanel.merge.replacementAriaLabel': 'Replacement attributes for {path}',
  'layersPanel.merge.replacementInvalid': 'Replacement must be a JSON object of attributes.',
  'layersPanel.merge.deleteCarries': {
    one: 'Delete decision carries {count} touched descendant: {list}',
    other: 'Delete decision carries {count} touched descendants: {list}',
  },
  'layersPanel.merge.title': 'Merge',
  'layersPanel.merge.refreshAriaLabel': 'Refresh refs and candidates',
  'layersPanel.merge.candidateLayerLabel': 'Candidate layer',
  'layersPanel.merge.targetRefLabel': 'Target ref',
  'layersPanel.merge.localRefOption': '{name} (local)',
  'layersPanel.merge.registryRefOption': '{name} (registry)',
  'layersPanel.merge.previewButton': 'Preview',
  'layersPanel.merge.statusPreview': {
    one: '{autoMerged} auto-merged, {count} conflict.',
    other: '{autoMerged} auto-merged, {count} conflicts.',
  },
  'layersPanel.merge.statusConflicts': {
    one: '{count} unresolved conflict.',
    other: '{count} unresolved conflicts.',
  },
  'layersPanel.merge.statusFastForward': 'Fast-forwarded.',
  'layersPanel.merge.statusMerged': 'Merged as {mergeLayerId}…',
  'layersPanel.merge.statusPolicyFailure': 'Blocked by ref policy: {reason}',
  'layersPanel.merge.statusUnrelatedBase': 'Unrelated base: {reason}',
  'layersPanel.merge.unrelatedBaseWarning': 'No shared base on this ref: the plan treats every candidate op as new. Candidates that declare a base from another history will be refused at merge.',
  'layersPanel.merge.requiredChecksLabel': 'Required checks',
  'layersPanel.merge.waiverPlaceholder': 'Waive with a reason (recorded in the merge manifest)',
  'layersPanel.merge.waiverAriaLabel': 'Waiver reason for {spec}',
  'layersPanel.merge.bulkLabel': 'Bulk:',
  'layersPanel.merge.allOurs': 'all ours',
  'layersPanel.merge.allTheirs': 'all theirs',
  'layersPanel.merge.bulkCount': '×{count}:',
  'layersPanel.merge.mergeWithResolutionsButton': 'Merge with resolutions',
  'layersPanel.merge.mergeButton': 'Merge',
  'layersPanel.merge.loadMergedRefButton': 'Load merged ref',
  'layersPanel.merge.toastMerged': "Merged into '{ref}' ({mergeLayerId}…).",
  'layersPanel.merge.toastFastForwarded': "Fast-forwarded '{ref}'.",
  'layersPanel.merge.toastPolicyError': 'Policy: {reason}',
  'layersPanel.merge.toastLoadedRef': "Loaded ref '{ref}' ({count} layers).",

  // LayerProvenanceDetail
  'layersPanel.provenance.noManifest': 'No provenance manifest — this layer is unsigned raw IFCX (an import or a foreign file).',
  'layersPanel.provenance.malformedManifest': {
    one: 'Provenance manifest present but malformed ({count} issue) — treating this layer as unsigned.',
    other: 'Provenance manifest present but malformed ({count} issues) — treating this layer as unsigned.',
  },
  'layersPanel.provenance.checksNoneAttached': 'none attached',
  'layersPanel.provenance.checkPassAriaLabel': 'pass',
  'layersPanel.provenance.checkFailAriaLabel': 'fail',
  'layersPanel.provenance.authorField': 'Author',
  'layersPanel.provenance.intentField': 'Intent',
  'layersPanel.provenance.createdField': 'Created',
  'layersPanel.provenance.baseField': 'Base',
  'layersPanel.provenance.scopeField': 'Scope',
  'layersPanel.provenance.checksField': 'Checks',
  'layersPanel.provenance.mergeField': 'Merge',
  'layersPanel.provenance.identityField': 'Identity',
  'layersPanel.provenance.signedField': 'Signed',
  'layersPanel.provenance.authorLine': '{kind} · {principal}',
  'layersPanel.provenance.authorToolSuffix': ' · {tool}',
  'layersPanel.provenance.baseNone': 'none (base/import layer)',
  'layersPanel.provenance.scopeUnrestricted': 'unrestricted',
  'layersPanel.provenance.checkReportTooltip': 'evidence report {report}',
  'layersPanel.provenance.mergeIntoBy': ' into {into} by {resolver}',
  'layersPanel.provenance.resolutionsCount': {
    one: '{count} resolution',
    other: '{count} resolutions',
  },
  'layersPanel.provenance.waivedCountSuffix': {
    one: ', {count} waived check',
    other: ', {count} waived checks',
  },
  'layersPanel.provenance.identityCount': {
    one: '{count} content-derived entity',
    other: '{count} content-derived entities',
  },
  'layersPanel.provenance.signaturesCount': {
    one: '{count} signature',
    other: '{count} signatures',
  },

  // LayerReviewSection
  'layersPanel.review.selectEntityTitle': 'Select the commented entity in 3D',
  'layersPanel.review.anonymousAuthor': 'anonymous',
  'layersPanel.review.topicMeta': '{tail} · {author} · {date}',
  'layersPanel.review.topicMetaViewpoint': '{tail} · {author} · {date} · viewpoint',
  'layersPanel.review.topicMetaComponent': '{tail} · {componentKey} · {author} · {date}',
  'layersPanel.review.topicMetaComponentViewpoint': '{tail} · {componentKey} · {author} · {date} · viewpoint',
  'layersPanel.review.title': 'Review',
  'layersPanel.review.refreshAriaLabel': 'Refresh review',
  'layersPanel.review.exportAriaLabel': 'Export review comments as BCF',
  'layersPanel.review.exportButtonLabel': '.bcf',
  'layersPanel.review.openReviewButton': 'Open review',
  'layersPanel.review.commentPlaceholderWithEntity': 'Comment on {tail}',
  'layersPanel.review.commentPlaceholderNoEntity': 'Select an entity in 3D to comment',
  'layersPanel.review.commentTitleAriaLabel': 'Review comment title',
  'layersPanel.review.descriptionPlaceholder': 'Description (optional)',
  'layersPanel.review.descriptionAriaLabel': 'Review comment description',
  'layersPanel.review.viewpointLabel': 'viewpoint',
  'layersPanel.review.commentButton': 'Comment',
  'layersPanel.review.postedToast': 'Review comment posted.',

  // LayersPanel
  'layersPanel.panel.authorHuman': 'Human',
  'layersPanel.panel.authorAgent': 'Agent',
  'layersPanel.panel.authorHybrid': 'Hybrid',
  'layersPanel.panel.unsigned': 'unsigned',
  'layersPanel.panel.nodeCount': { one: '{count} node', other: '{count} nodes' },
  'layersPanel.panel.provenanceAriaLabel': 'Provenance of {name}',
  'layersPanel.panel.mergeLayerLabel': 'Merge layer',
  'layersPanel.panel.checksBadge': '{passed}/{total} checks',
  'layersPanel.panel.hideButton': 'Hide',
  'layersPanel.panel.changesButton': 'Changes',
  'layersPanel.panel.heroTitle': 'Layers: version your model like code',
  'layersPanel.panel.heroDescription': 'An IFC5 model composes from immutable layers. Inspect who changed what, publish your edits as new layers, and merge them with reviews, checks, and conflict resolution.',
  'layersPanel.panel.loadingDemo': 'Loading…',
  'layersPanel.panel.loadDemoStack': 'Load demo stack',
  'layersPanel.panel.openFilesButton': 'Open .ifcx files',
  'layersPanel.panel.dropHint': 'You can also drop several .ifcx files anywhere in the viewer.',
  'layersPanel.panel.layerCountHeader': { one: '{count} layer, strongest on top', other: '{count} layers, strongest on top' },
  'layersPanel.panel.computingChanges': 'Computing changes…',
} as const satisfies Record<string, TranslationValue>;
