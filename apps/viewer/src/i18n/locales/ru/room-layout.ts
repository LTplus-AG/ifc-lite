/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const roomLayoutRu = {
  "roomLayout.mode.edit": "Редактировать",
  "roomLayout.tool.label": "Что делает щелчок по планировке",
  "roomLayout.tool.shape": "Переместить · Вырезать",
  "roomLayout.tool.remove": "Объединить · Удалить",
  "roomLayout.tool.shapeTitle": "Перетащите угол, чтобы переместить его; щёлкните две точки на контуре помещения, чтобы разрезать помещение между ними",
  "roomLayout.tool.removeTitle": "Щёлкните стену между двумя помещениями, чтобы объединить их; щёлкните угол, чтобы удалить его",
  "roomLayout.cleanup.label": "Очистить",
  "roomLayout.cleanup.title": "Удалить из планировки висячие стены, изолированные узлы и лишние углы с отменой одним действием",
  "roomLayout.hint.shape": "Перетащите угол, чтобы переместить его · щёлкните контур помещения, чтобы начать разрез",
  "roomLayout.hint.remove": "Щёлкните стену между двумя помещениями, чтобы объединить их, или угол, чтобы удалить его",
  "roomLayout.hint.drop": "Отпустите кнопку мыши или щёлкните, чтобы разместить угол · Esc отменяет",
  "roomLayout.hint.cutEnd": "Щёлкните другую точку на том же контуре помещения, чтобы разделить его · Esc отменяет",
  "roomLayout.hint.open": "Стены не замыкают эту область: открытые концы стен отмечены",
  "roomLayout.edit.none": "Сначала укажите на угол или контур помещения",
  "roomLayout.edit.refused": "Планировка не допускает эту правку: {reason}",
  "roomLayout.prune.none": "Ничего не нужно убирать: в планировке нет изолированных стен или узлов",
  "roomLayout.refused.shape": "Помещение здесь не представляет собой контур, экструдированный вертикально вверх, поэтому его форму нельзя изменить: используйте Обновить помещения или перерисуйте его",
  "roomLayout.refused.storey": "Помещение здесь расположено вне этажа, поэтому его форму изменить нельзя",
  "roomLayout.refused.merge": "Одно из объединённых помещений не удалось удалить",
  "roomLayout.more.label": "Ещё",
  "roomLayout.more.title": "Контур, автоматическое построение на каждом этаже, объединение углов и диагностика незамкнутости",
  "roomLayout.footprint.label": "Контур",
  "roomLayout.footprint.title": "Одно помещение по всему контуру этого этажа, с отменой одним действием",
  "roomLayout.footprint.taken": "На этом этаже уже есть помещения: Контур создаёт одно помещение на весь этаж, которое перекрыло бы их",
  "roomLayout.autoAll.label": "Авто на каждом этаже",
  "roomLayout.autoAll.title": "Создать помещение в каждой замкнутой стенами области без помещения на всех этажах за одно отменяемое действие",
  "roomLayout.autoAll.none": "Во всех замкнутых стенами областях на всех этажах уже есть помещения",
  "roomLayout.weld.label": "Объединение углов",
  "roomLayout.weld.title": "Насколько близко должны находиться два угла стен, чтобы считаться одним: увеличьте значение, если сходящиеся стены не замыкают помещение",
  "roomLayout.weld.aria": "Допуск объединения углов (м)",
  "roomLayout.weld.auto": "По умолчанию (5 см)",
  "roomLayout.weld.reset": "Сбросить до значения по умолчанию 5 см",
  "roomLayout.weld.rooms": {
    one: "{countDisplay} помещение",
    many: "{countDisplay} помещений",
    other: "{countDisplay} помещения",
  },
  "roomLayout.leaks.label": "Показать разрывы",
  "roomLayout.leaks.title": "Отметить стены, не ограничивающие ни одного помещения, и свободные концы стен: почему область не замкнута",
} satisfies Catalogue;
