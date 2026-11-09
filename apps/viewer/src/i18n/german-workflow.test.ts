/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { workflowContract } from './__tests__/workflow-contract';

workflowContract('German', 'locale-de-CH-negotiation', () => import('../../../../tools/localization-german/workflow-verdict.mjs'));
