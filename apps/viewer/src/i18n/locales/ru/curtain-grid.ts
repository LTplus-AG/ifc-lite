/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const curtainGridRu = {
  "curtainWall.label": "Витражная стена",
  "curtainWall.palette": "Разместить витражные стены",
  "commands.model.curtainWall": "Разместить витражные стены: стойки, ригели и панели (рабочая область модели)",
  "curtainWall.hint.start": "Нажмите, чтобы начать витражную стену · введите длину для фиксации",
  "curtainWall.hint.end": "Щёлкните или нажмите Enter для размещения · сетка показывает её панели · Esc начинает заново",
  "curtainWall.field.baseOffset": "Смещение основания",
  "curtainWall.field.panelWidth": "Ширина панели",
  "curtainWall.field.panelHeight": "Высота панели",
  "curtainWall.field.mullionWidth": "Ширина стойки",
  "curtainWall.field.mullionDepth": "Глубина стойки",
  "curtainWall.tooShort": "Витражная стена слишком короткая: щёлкните дальше от начала",
  "curtainWall.noOpening": "Стойки и ригели не оставляют свободного проёма: расширьте панели или уменьшите толщину стойки",
  "curtainWall.tooManyPanels": "Такой размер панелей приводит к слишком большому количеству панелей: сделайте их больше",
  "curtainWall.summary": "панели {bays} × {rows}",
  "grid.label": "Координационные оси",
  "grid.palette": "Разместить координационные оси",
  "commands.model.grid": "Разместить проектную сетку с обозначенными осями (рабочая область модели)",
  "grid.hint.corner": "Щёлкните по первому углу сетки · введите ширину, чтобы зафиксировать её",
  "grid.hint.opposite": "Щёлкните противоположный угол или нажмите Enter · Shift делает сетку квадратной · Esc начинает заново",
  "grid.field.spacingU": "Шаг по U",
  "grid.field.spacingV": "Шаг по V",
  "grid.tags.label": "Как маркируются оси",
  "grid.tags.numbers": "1, 2, 3",
  "grid.tags.letters": "A, B, C",
  "grid.noArea": "У сетки нет площади: щёлкните угол дальше от первого",
  "grid.tooManyAxes": "При таком шаге получается слишком много осей: увеличьте шаг",
  "grid.summary": "Оси {uAxes} × {vAxes}",
} satisfies Catalogue;
