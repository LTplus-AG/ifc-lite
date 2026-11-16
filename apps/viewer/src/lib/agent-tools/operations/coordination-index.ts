/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { coordinationBcfOperations } from './coordination-bcf';
import { coordinationCompareOperations } from './coordination-compare';
import { coordinationFlowOperations } from './coordination-flow';
import { coordinationInfluxOperations } from './coordination-influx';
import { coordinationLayerOperations } from './coordination-layers';
import { coordinationLoadReportOperations } from './coordination-load-report';
import { coordinationProviderOperations } from './coordination-providers';
import { coordinationReviewOperations } from './coordination-review';
import { coordinationScriptSessionOperations } from './coordination-script-session';
import { coordinationSemanticOperations } from './coordination-semantic';
export const coordinationOperations = [...coordinationBcfOperations, ...coordinationCompareOperations,
  ...coordinationFlowOperations, ...coordinationInfluxOperations, ...coordinationLayerOperations,
  ...coordinationLoadReportOperations, ...coordinationProviderOperations, ...coordinationReviewOperations,
  ...coordinationScriptSessionOperations, ...coordinationSemanticOperations];
