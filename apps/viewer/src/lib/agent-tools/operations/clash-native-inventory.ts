/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** Current ClashPanel and its native child dialogs/workflows. Bindings do not
 * claim geometry support beyond the native engine's explicit diagnostics. */
export const clashControlBindings = [
  {
    controls: [
      'hard/clearance mode',
      'tolerance',
      'clearance distance',
      'duplicate tolerance',
      'cluster distance',
      'report touching',
      'default grouping',
      'reset detection settings',
    ],
    status: 'implemented',
    operations: ['clash.state', 'clash.settings.write', 'clash.action'],
  },
  {
    controls: [
      'rule preset create/edit/delete/enable/reset',
      'selector A/B',
      'native side set/model-tag filters',
      'preset severity/description',
      'preset JSON import/export',
    ],
    status: 'implemented',
    operations: ['clash.state', 'clash.presets.write', 'clash.export'],
  },
  {
    controls: [
      'detect all',
      'discipline matrix',
      'one preset',
      'duplicate scan',
      'recorded rerun',
      'cancel',
      'clear results',
    ],
    status: 'implemented',
    operations: ['clash.run', 'clash.action'],
    boundary:
      'Uses native federated mesh gathering, effective filters/tags, engine cancellation, run supersession and federation/placement guards. Native shape-only/no-geometry and unsupported solid outcomes remain refusals.',
  },
  {
    controls: [
      'read native result/coverage',
      'review open/resolved/accepted',
      'review comment',
      'type-any/type-pair/element-pair exclusions',
      'toggle/remove/clear exclusions',
      'suppression counts',
    ],
    status: 'implemented',
    operations: ['clash.state', 'clash.results', 'clash.review', 'clash.exclusions.write'],
    boundary:
      'Native exclusion changes rederive existing findings/groups without rerunning and retain duplicate-set grouping provenance.',
  },
  {
    controls: [
      'focus pair',
      'step to element A/B',
      'highlight/isolate/ghost',
      'highlight all',
      'clear highlight',
      'contact box toggle',
      'intersection-solid outcome',
    ],
    status: 'implemented',
    operations: ['clash.focus', 'clash.action', 'clash.viewSettings', 'clash.state'],
    boundary:
      'Native model-qualified ref/source guards and shared visibility ownership retained. Pair focus dispatches native async solid work; actual solid/unavailable/computing status is inspectable, never labeled completed geometry.',
  },
  {
    controls: [
      'BCF archive grouping/severity/selected-or-filtered finding scope/topic cap/snapshots',
      'CSV table',
      'create in-app BCF topic for pair/report/manual group',
    ],
    status: 'implemented',
    operations: ['clash.exportBcf', 'clash.export', 'clash.topic.create'],
    boundary:
      'Exact shared panel writers/capture services; native renderer/camera and scene/camera-current checks apply. Cancellation suppresses publication while already-admitted snapshot work may settle.',
  },
  {
    controls: [
      'manual group create/rename/add/move/remove members/remove group',
      'group workspace selection',
      'storage retry/restore',
      'group membership identities',
    ],
    status: 'implemented',
    operations: ['clash.groups.read', 'clash.groups.evidence', 'clash.groups.write', 'clash.groups.library'],
    boundary:
      'Native whole-partition codec rejects duplicate/overlapping occurrence claims; content writer provides durable save diagnostics. Checkbox selection is expressed by explicit clash_ids/member identities.',
  },
  {
    controls: ['draft BCF topics from active groups', 'draft BCF topic from selected findings'],
    status: 'implemented',
    operations: ['clash.drafts.create'],
    boundary:
      'Uses exact native currentDraftRun/draftBatchFromGroups/draftBatchFromSelection/saveDraftBatch, preserving grouping/provenance/frame semantics. Server publication remains a separate BCF workflow.',
  },
  {
    controls: [
      'Assistant typed sample grouping preview',
      'classify-all estimate',
      'classify-all start/cancel/normalization consent',
      'review group rename/move/new group/unclassify/merge',
      'apply to new/existing workspace',
      'confirm moved findings',
      'receipt Undo',
    ],
    status: 'implemented',
    operations: [
      'clash.classification.prepare',
      'clash.classification.sample',
      'clash.classification.run',
      'clash.classification.edit',
      'clash.classification.plan',
      'clash.classification.apply',
      'clash.classification.undo',
    ],
    boundary:
      'Canonical native evidence/chunking/gates/root-budget/provider route and optimistic content transaction. Full-run network cancellation uses the host/session signal. Configuration/credential/budget failures are explicit; no fabricated classification.',
  },
  {
    controls: [
      'quality threshold add/remove/percentage/label/color',
      'quality native summary',
      'save quality report',
      'saved report inspect/rename/import/storage restore/retry',
      'saved report delete dependency review/apply',
      'quality Document',
    ],
    status: 'implemented',
    operations: [
      'clash.quality.read',
      'clash.quality.write',
      'clash.reports.save',
      'clash.reports.read',
      'clash.reports.write',
      'clash.reports.delete.prepare',
      'clash.reports.delete.apply',
      'clash.reports.document',
    ],
    boundary:
      'Native immutable report/quality codecs preserve stale/partial coverage. Deletion rechecks target identity and native live/durable chart dependency signature immediately before persistence. Quality Document uses native Canvas2D ring rendering and refuses unavailable capture.',
  },
  {
    controls: [
      'save/clear baseline',
      'compare current revision with baseline',
      'read resolved/new/unretested differences',
    ],
    status: 'implemented',
    operations: ['clash.revision'],
    boundary: 'Uses native baseline storage/model-name identity and compareClashRevisions; no ad-hoc matching.',
  },
  {
    controls: [
      'pairs/clusters/duplicate-set layout',
      'collapse/expand result rows/groups',
      'controls disclosure',
      'text search',
      'selection checkboxes',
      'status/touching/sort/focus preference widgets',
      'scroll/resize/dialog opening',
    ],
    status: 'presentation-only',
    operations: ['clash.results', 'clash.viewSettings', 'clash.state'],
    boundary:
      'Complete native findings remain available as data; explicit finding IDs replace checkbox gestures. View preferences also have parameterized native handlers.',
  },
] as const;
