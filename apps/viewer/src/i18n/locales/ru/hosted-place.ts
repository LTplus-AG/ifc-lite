/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const hostedPlaceRu = {
  "hostedPlace.tool.opening": "Проём",
  "hostedPlace.tool.door": "Дверь",
  "hostedPlace.tool.window": "Окно",
  "hostedPlace.hint.opening": "Наведите указатель на стену и нажмите, чтобы вырезать проём · Esc для выхода",
  "hostedPlace.hint.door": "Наведите указатель на стену и нажмите для размещения двери · Esc для выхода",
  "hostedPlace.hint.window": "Наведите указатель на стену и нажмите для размещения окна · Esc для выхода",
  "hostedPlace.field.offset": "Смещение",
  "hostedPlace.field.sill": "Отметка низа",
  "hostedPlace.noHost": "Двери, окна и проёмы размещаются в стене: укажите на стену на этом этаже",
  "hostedPlace.outsideHost": "Не помещается в этой стене: измените смещение, отметку низа или размер",
  "commandPalette.tool.opening.label": "Вырезать проёмы",
  "commandPalette.tool.door.label": "Разместить двери",
  "commandPalette.tool.window.label": "Разместить окна",
  "commands.model.opening": "Прорезать проёмы в стенах (рабочая область модели)",
  "commands.model.door": "Разместить двери в стенах (рабочая область модели)",
  "commands.model.window": "Разместить окна в стенах (рабочая область модели)",
  "modelInspector.hosting.host": "Основа",
  "modelInspector.hosting.selectHost": "Выбрать основу",
  "modelInspector.hosting.offset": "Смещение",
  "modelInspector.hosting.sill": "Отметка низа",
  "modelInspector.hosting.none": "Элемент не вставлен в проём стены.",
  "modelInspector.hosting.invalid": "Введите длину в метрах",
  "modelInspector.type.noClass": "В {schema} нет {typeClass}, поэтому у этого элемента не сохраняется тип.",
} satisfies Catalogue;
