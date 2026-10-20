/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const propertiesSelectionRu = {
  "properties.copy.valueLabel": "Скопировать {name}",
  "properties.copy.valueTooltip": "Скопировать {name} (Shift или удержание: скопировать имя=значение)",
  "properties.copy.copied": "Скопировано в буфер обмена",
  "properties.copy.failed": "Не удалось скопировать в буфер обмена",
  "properties.summary.elementCount": {
    one: "{countDisplay} элемент",
    many: "{countDisplay} элементов",
    other: "{countDisplay} элемента",
  },
  "properties.summary.byClassHeading": "По классам",
  "properties.summary.byModelHeading": "По модели",
  "properties.summary.elementsHeading": "Элементы",
  "properties.summary.attributesHeading": "Общие атрибуты",
  "properties.summary.propertiesHeading": "Общие свойства",
  "properties.summary.quantitiesHeading": "Общие количественные характеристики",
  "properties.summary.varies": {
    one: "(различается: {countDisplay} значение)",
    many: "(различается: {countDisplay} значений)",
    other: "(различается: {countDisplay} значения)",
  },
  "properties.summary.noShared": "Выбранные элементы не имеют общих свойств или количественных характеристик",
  "properties.summary.selectOnly": "Выбрать только {name}",
  "properties.summary.moreElements": {
    one: "Ещё {countDisplay} элемент",
    many: "Ещё {countDisplay} элементов",
    other: "Ещё {countDisplay} элемента",
  },
  "properties.summary.valuesCapped": "Значения сравниваются по первым элементам {limit} из {total}",
} satisfies Catalogue;
