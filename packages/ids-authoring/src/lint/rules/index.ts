/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The static lint catalogue, in documentation order. */

import type { LintRule } from '../types.js';
import { ENT_001, ENT_002, ENT_003, ENT_004, ENT_005 } from './entity.js';
import { ATT_001, ATT_002, PDT_001, PDT_002, PDT_003 } from './pdt-att.js';
import { PROP_001, PROP_002, PROP_003, PSET_001, PSET_002, PSET_003 } from './pset.js';

export const LINT_RULES: readonly LintRule[] = [
  ENT_001,
  ENT_002,
  ENT_003,
  ENT_004,
  ENT_005,
  PDT_001,
  PDT_002,
  PDT_003,
  ATT_001,
  ATT_002,
  PSET_001,
  PSET_002,
  PSET_003,
  PROP_001,
  PROP_002,
  PROP_003,
];
