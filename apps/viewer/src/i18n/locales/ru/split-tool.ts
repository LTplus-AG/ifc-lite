/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const splitToolRu = {
  "splitTool.barLabel": "Разделить",
  "splitTool.hint": "Наведите указатель мыши на выбранный элемент, чтобы выполнить разрез · введите расстояние или проценты · нажмите Esc для выхода",
  "splitTool.unitMetres": "м",
  "splitTool.cutDistanceAria": "Расстояние сечения в метрах или процент от длины элемента",
  "splitTool.unavailable.type": "Разделение работает со стенами, балками, колоннами, стержневыми элементами, плитами перекрытия, крышами, листовыми элементами и пространствами",
  "splitTool.unavailable.storey": "Разделение невозможно: элемент не находится на этаже здания",
  "splitTool.unavailable.container": "Разделить невозможно: элемент расположен непосредственно в здании или на участке, а не на этаже. Сначала переместите его на этаж",
  "splitTool.unavailable.noBody": "Невозможно разделить: у элемента отсутствует геометрия тела",
  "splitTool.unavailable.mesh": "Невозможно разделить: геометрия представляет собой сетку или B-rep, а не экструзию профиля",
  "splitTool.unavailable.mapped": "Разделение невозможно: геометрия используется совместно с типом (маппирование представления)",
  "splitTool.unavailable.boolean": "Невозможно разделить: геометрия представляет собой тело, обрезанное булевыми операциями",
  "splitTool.unavailable.profile": "Разделение невозможно: профиль экструзии не имеет прямоугольной формы",
  "splitTool.unavailable.shape": "Разделение невозможно: размещение или структура представления не поддерживается",
  "splitTool.unavailable.kind": "Разделение невозможно: данный метод разделения не применяется к этому элементу",
  "splitTool.failed": "Не удалось разделить: {reason}",
} satisfies Catalogue;
