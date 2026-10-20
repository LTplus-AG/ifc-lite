/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const copyArrayRu = {
  "commands.model.copy": "Скопировать выбранные элементы (рабочая область модели)",
  "commands.model.paste": "Вставить скопированные элементы в положение курсора (рабочая область модели)",
  "commands.model.pasteInPlace": "Вставить скопированные элементы на прежнее место, на текущем этаже (рабочая область модели)",
  "commands.model.array": "Повторить выбранные элементы в ряд или вокруг центра (рабочая область модели)",
  "copyArray.copied": {
    one: "Скопирован {countDisplay} элемент",
    few: "Скопированы {countDisplay} элемента",
    many: "Скопировано {countDisplay} элементов",
    other: "Скопировано {countDisplay} элемента",
  },
  "copyArray.paste.label": "Вставить",
  "copyArray.paste.hint": "Щёлкните в том месте, куда будет вставлена копия. Чтобы вставить на другой этаж, сначала переключитесь на другой этаж",
  "copyArray.paste.empty": "Пока ничего не скопировано: сначала выберите элементы и скопируйте их",
  "copyArray.paste.stale": "Скопированные элементы больше нельзя скопировать: выделите их и скопируйте снова",
  "copyArray.paste.otherModel": "Скопированные элементы находятся в другой модели: вставьте их туда",
  "copyArray.tool.array": "Массив",
  "copyArray.blocked.array": "Сначала выберите элементы для повторения",
  "copyArray.array.label": "Массив",
  "copyArray.array.noSelection": "Сначала выберите элементы для повторения",
  "copyArray.array.refused": "Эти элементы нельзя повторить: нажмите, чтобы узнать почему",
  "copyArray.array.linearStart": "Нажмите там, где начинается направление",
  "copyArray.array.linearEnd": "Щёлкните в конечной точке: это расстояние соответствует одному шагу (Шаг) или всему массиву (По длине)",
  "copyArray.array.polarCentre": "Щёлкните в центре, вокруг которого нужно повернуть копии",
  "copyArray.array.polarCommit": "Нажмите кнопку мыши или клавишу Enter, чтобы разместить копии",
  "copyArray.field.count": "Количество",
  "copyArray.field.spacing": "Шаг",
  "copyArray.field.total": "Общая длина",
  "copyArray.field.angle": "Угол",
  "copyArray.mode.label": "Тип массива",
  "copyArray.mode.linear": "Линейный",
  "copyArray.mode.polar": "Полярный",
  "copyArray.fit.label": "Что задаёт расстояние",
  "copyArray.fit.spacing": "Шаг",
  "copyArray.fit.fit": "По длине",
  "copyArray.fit.spacingTitle": "Расстояние задаёт шаг от одной копии к следующей",
  "copyArray.fit.fitTitle": "Расстояние охватывает весь массив",
} satisfies Catalogue;
