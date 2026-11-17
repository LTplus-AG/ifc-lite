/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { workflowContract } from './__tests__/workflow-contract';

workflowContract('Italian', 'locale-it-CH-negotiation', () => import('../../../../tools/localization-italian/workflow-verdict.mjs'));
