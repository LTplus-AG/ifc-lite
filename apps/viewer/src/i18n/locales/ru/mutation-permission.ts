/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const mutationPermissionRu = {
  "mutationPermission.workflowRunning": "Дождитесь завершения проверки рабочего процесса или захвата PDF, или отмените рабочий процесс",
  "mutationPermission.editModeRequired": "Включите режим редактирования, чтобы изменить эту модель",
  "mutationPermission.roleRequired": "Для редактирования требуется доступ редактора в этой общей сессии",
  "mutationPermission.modelUnavailable": "Данная модель не содержит редактируемых данных IFC",
} satisfies Catalogue;
