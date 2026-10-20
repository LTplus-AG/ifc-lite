/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const appearanceAssignmentListRu = {
  "appearanceAssignmentList.sectionAriaLabel": "Назначения внешнего вида",
  "appearanceAssignmentList.heading": "Назначения",
  "appearanceAssignmentList.description": "Последующие назначения заменяют предыдущие на общих для них объектах. Исключение объекта здесь сохраняет любое предыдущее назначение.",
  "appearanceAssignmentList.assignmentAriaLabel": "Назначение {position}: {sourceName} к {modelName}",
  "appearanceAssignmentList.moveEarlierAriaLabel": "Переместить назначение {position} выше",
  "appearanceAssignmentList.moveLaterAriaLabel": "Переместить назначение {position} ниже",
  "appearanceAssignmentList.removeAriaLabel": "Удалить назначение {position}",
  "appearanceAssignmentList.summary": "{products} · {excluded} · {overridden}",
  "appearanceAssignmentList.summaryProducts": {
    one: "{count} объект",
    many: "{count} объектов",
    other: "{count} объекта",
  },
  "appearanceAssignmentList.summaryExcluded": {
    one: "{count} исключён",
    few: "{count} исключены",
    many: "{count} исключены",
    other: "{count} исключено",
  },
  "appearanceAssignmentList.summaryOverridden": {
    one: "{count} заменён последующим назначением",
    few: "{count} заменены последующими назначениями",
    many: "{count} заменены последующими назначениями",
    other: "{count} заменено последующими назначениями",
  },
  "appearanceAssignmentList.reviewAriaLabel": "Проверить объекты назначения {position}",
  "appearanceAssignmentList.reviewButton": "Проверить объекты и исключения",
} satisfies Catalogue;
