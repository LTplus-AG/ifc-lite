/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const mutationPermissionFr = {
  "mutationPermission.workflowRunning": "Attendez la fin du contrôle du workflow ou de la capture PDF, ou annulez le workflow",
  "mutationPermission.editModeRequired": "Activez le mode Édition pour modifier ce modèle",
  "mutationPermission.roleRequired": "La modification nécessite un accès éditeur dans cette session partagée",
  "mutationPermission.modelUnavailable": "Ce modèle ne contient aucune donnée IFC modifiable",
} satisfies Catalogue;
