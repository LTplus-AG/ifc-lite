/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const stairRailingRu = {
  "stairRailing.tool.stair": "Лестница",
  "stairRailing.tool.railing": "Ограждение",
  "stairRailing.stair.label": "Лестница",
  "stairRailing.railing.label": "Ограждение",
  "stairRailing.field.riser": "Подступенок",
  "stairRailing.field.tread": "Проступь",
  "stairRailing.field.waist": "Наклонная плита марша",
  "stairRailing.inspector.RiserHeight": "Высота подступенка",
  "stairRailing.inspector.TreadLength": "Длина проступи",
  "stairRailing.inspector.WaistThickness": "Толщина плиты марша",
  "stairRailing.inspector.effect": "Основание и число подступенков остаются фиксированными. Высота подступенка меняет общий подъём; длина проступи меняет общую горизонтальную длину.",
  "stairRailing.field.postSpacing": "Стойки",
  "stairRailing.stair.hintStart": "Нажмите у основания первого подступенка · введите длину для фиксации горизонтальной длины",
  "stairRailing.stair.hintEnd": "Щёлкните или нажмите Enter для размещения лестницы · введите длину, Tab для угла, подступенка, проступи · Backspace начинает заново · Esc для выхода",
  "stairRailing.stair.tooShort": "Горизонтальная длина слишком мала: проступи меньше 0,1 м не образуют лестницу. Нарисуйте длиннее или задайте более высокий подступенок для меньшего числа ступеней",
  "stairRailing.stair.waistTooThick": "Толщина плиты марша слишком велика для такого подъёма: введите меньшую",
  "stairRailing.stair.risers": {
    one: "{countDisplay} подступенок · до {storey}",
    many: "{countDisplay} подступенков · до {storey}",
    other: "{countDisplay} подступенка · до {storey}",
  },
  "stairRailing.stair.risersFree": {
    one: "{countDisplay} подступенок · без этажа выше",
    many: "{countDisplay} подступенков · без этажа выше",
    other: "{countDisplay} подступенка · без этажа выше",
  },
  "stairRailing.railing.hintStart": "Нажмите, чтобы начать ограждение · привязка к рёбрам плит и бокам лестниц · введите длину для фиксации",
  "stairRailing.railing.hintNext": "Нажмите для добавления точки · двойное нажатие или Enter для завершения · Backspace удаляет точку · Esc начинает заново",
  "stairRailing.railing.needTwo": "Для ограждения нужны как минимум две точки",
  "stairRailing.railing.summary": {
    one: "{countDisplay} точка · {length}",
    many: "{countDisplay} точек · {length}",
    other: "{countDisplay} точки · {length}",
  },
  "stairRailing.railing.finish": "Завершить",
  "stairRailing.railing.finishTitle": "Разместить ограждение вдоль уже заданных точек (Enter)",
  "commandPalette.tool.stair.label": "Нарисовать лестницу",
  "commandPalette.tool.railing.label": "Нарисовать ограждения",
  "commands.model.stair": "Нарисовать лестницу до этажа выше (рабочая область модели)",
  "commands.model.railing": "Нарисовать ограждение вдоль траектории (рабочая область модели)",
} satisfies Catalogue;
