/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const pushPullAlignRu = {
  "commands.model.pushPull": "Вдавить или вытянуть грань выбранного элемента (рабочая область модели)",
  "commands.model.align": "Выровнять элементы по краю опорного объекта (рабочая область модели)",
  "modelWorkspace.tool.pushPull": "Вдавить / Вытянуть",
  "modelWorkspace.tool.align": "Выровнять",
  "modelWorkspace.blocked.pushPull": "Выберите стену, плиту, колонну или балку для вдавливания или вытягивания",
  "commandPalette.tool.pushPull.label": "Вдавить / Вытянуть грань",
  "commandPalette.tool.align.label": "Выровнять элементы",
  "pushPull.label": "Вдавить / Вытянуть",
  "pushPull.field.size": "Размер",
  "pushPull.hint.noTarget": "Выберите стену, плиту, колонну или балку для вдавливания или вытягивания её граней.",
  "pushPull.hint.pick": "Возьмите маркер для выбора грани, затем перетащите его или введите размер",
  "pushPull.hint.drag": "Перетащите или введите размер · щелчок или Enter применяет · Esc отменяет",
  "pushPull.unchanged": "Размер не изменился.",
  "pushPull.face.wallHeight": "Высота стены",
  "pushPull.face.wallThickness": "Толщина стены",
  "pushPull.face.slabThickness": "Толщина плиты",
  "pushPull.face.length": "Длина",
  "pushPull.handleAria": "{face}: потяните",
  "pushPull.bar.readout": "{face} {delta} м",
  "pushPull.bar.snapLevel": "Привязано к уровню пола",
  "pushPull.bar.snapStep": "Привязано к шагу",
  "align.label": "Выровнять",
  "align.hint.reference": "Щёлкните элемент, по которому нужно выровнять остальные",
  "align.hint.targets": "Щёлкните элементы для выравнивания по нему",
  "align.hint.commit": "Enter выравнивает их · щелчок по элементу добавляет или исключает его · Esc начинает заново",
  "align.alreadyAligned": "Они уже выровнены по этому краю.",
  "align.mode.aria": "Край для выравнивания",
  "align.mode.left": "Слева",
  "align.mode.centre": "Центр",
  "align.mode.right": "Справа",
  "align.mode.top": "Сверху",
  "align.mode.middle": "Середина",
  "align.mode.bottom": "Снизу",
  "align.bar.count": "Выбрано {targets} · к перемещению {moving}",
} satisfies Catalogue;
