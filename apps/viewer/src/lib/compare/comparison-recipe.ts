/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelSelector } from '@ifc-lite/flow-nodes';

/** A rerunnable setup, deliberately distinct from completed comparison evidence (#6612). */
export interface ComparisonRecipe {
  kind: 'ifc-lite-comparison-recipe';
  version: 1;
  id: string;
  name: string;
  base: ModelSelector;
  head: ModelSelector;
  options: {
    scope: 'data' | 'geometry' | 'both';
    excludedTypes: string[];
    matchByContent: boolean;
    keyProperty?: string;
  };
}
