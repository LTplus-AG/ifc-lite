/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Source-owned type groups emitted into the sandbox scripting declarations. */
export const BIM_DERIVED_TYPE_GROUPS = [
  {
    title: 'Generic group lifecycle types', namespace: 'BimGroup',
    sources: ['packages/sdk/src/store-group-types.ts', 'packages/sdk/src/types.ts',
      'packages/create/src/in-store/group.ts', 'packages/create/src/in-store/group-graph.ts'],
    roots: ['GroupStoreIdentity', 'GroupStoreSnapshot', 'GroupStoreCreateParams', 'GroupStorePatch'],
  },
  {
    title: 'Modelling operation types', namespace: 'BimCreate',
    sources: [
      'packages/create/src/in-store/wall-join.ts', 'packages/create/src/in-store/wall-join-apply.ts',
      'packages/create/src/in-store/column.ts', 'packages/create/src/in-store/beam.ts',
      'packages/create/src/in-store/align-boxes.ts',
      'packages/create/src/in-store/member.ts', 'packages/create/src/in-store/profile.ts',
    ],
    roots: [
      'AlignMode', 'WallJoinApplyOptions', 'WallJoinOptions',
      'ColumnInStoreParams', 'ProfiledColumnInStoreParams',
      'BeamInStoreParams', 'ProfiledBeamInStoreParams',
      'MemberInStoreParams', 'ProfiledMemberInStoreParams',
    ],
  },
  {
    title: 'Clash engine types', namespace: 'BimClash',
    sources: ['packages/clash/src/types.ts', 'packages/clash/src/disciplines.ts', 'packages/spatial/src/aabb.ts'],
    roots: ['ClashResult', 'ClashGroup', 'ClashRule', 'ClashRulePreset'],
  },
  {
    title: 'Cost SDK types', namespace: 'BimCost',
    sources: [
      'packages/sdk/src/cost-types.ts', 'packages/sdk/src/types.ts',
      'packages/create/src/types-cost.ts',
    ],
    roots: [
      'CostGraphData', 'CostScheduleData', 'CostItemData', 'CostValueData',
      'CostEvaluationOptions', 'CostEvaluationData', 'CostScheduleParams',
      'CostItemParams', 'CostValueParams', 'CostQuantityParams',
    ],
  },
  {
    title: 'SDK relationship types', namespace: 'BimSdk',
    sources: ['packages/sdk/src/types.ts'],
    roots: ['EntityRelationshipsData'],
  },
];
