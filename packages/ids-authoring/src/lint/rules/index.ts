/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The static lint catalogue, in documentation order. */

import type { LintRule } from '../types.js';
import { ENT_001, ENT_002, ENT_003, ENT_004, ENT_005 } from './entity.js';
import { ATT_001, ATT_002, PDT_001, PDT_002, PDT_003 } from './pdt-att.js';
import { CARD_001, CARD_002, CARD_003, CARD_004 } from './card.js';
import { SPEC_001, SPEC_002, SPEC_003, SPEC_007, SPEC_008 } from './spec.js';
import { SPEC_005, SPEC_006, SPEC_009 } from './spec-doc.js';
import { REGEX_001, REGEX_002, REGEX_003, REGEX_004 } from './regex.js';
import { UNIT_001, VAL_008 } from './units.js';
import { VAL_001, VAL_002, VAL_003, VAL_004, VAL_005, VAL_006 } from './values.js';
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
  VAL_001,
  VAL_002,
  VAL_003,
  VAL_004,
  VAL_005,
  VAL_006,
  VAL_008,
  UNIT_001,
  REGEX_001,
  REGEX_002,
  REGEX_003,
  REGEX_004,
  CARD_001,
  CARD_002,
  CARD_003,
  CARD_004,
  SPEC_001,
  SPEC_002,
  SPEC_003,
  SPEC_005,
  SPEC_006,
  SPEC_007,
  SPEC_008,
  SPEC_009,
];
