/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Source-owned type groups emitted into the sandbox scripting declarations. */
export const BIM_DERIVED_TYPE_GROUPS = [
  {
    title: 'Modelling operation types', namespace: 'BimCreate',
    sources: ['packages/create/src/in-store/wall-join.ts', 'packages/create/src/in-store/wall-join-apply.ts'],
    roots: ['WallJoinApplyOptions', 'WallJoinOptions'],
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
