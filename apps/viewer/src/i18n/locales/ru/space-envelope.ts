/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const spaceEnvelopeRu = {
  "spaceEnvelope.label": "Изменить оболочку помещения",
  "spaceEnvelope.mode": "Форма потолка",
  "spaceEnvelope.flat": "Плоский",
  "spaceEnvelope.slope": "Наклонный",
  "spaceEnvelope.pitched": "Скатный",
  "spaceEnvelope.floor": "Отметка пола",
  "spaceEnvelope.left": "Отметка левого карниза",
  "spaceEnvelope.right": "Отметка правого карниза",
  "spaceEnvelope.ridge": "Отметка конька",
  "spaceEnvelope.pick": "Используйте вид спереди или разрез. Нажмите маркер пола, карниза или конька, переместите его и нажмите для применения. Enter применяет введённые высотные отметки. Alt временно отключает привязку.",
  "spaceEnvelope.move": "Переместитесь к краю крыши или вершине для привязки; щелчок мышью или клавиша Enter применяет одно изменение. Нажатие клавиши Escape отменяет действие.",
  "spaceEnvelope.refused": "Выберите помещение с вертикальной экструзией прямоугольника или многоугольника. Используйте вертикальный вид вдоль ската крыши. Сетку, сопоставленную геометрию, геометрию с отверстиями, наклонную и нечитаемую геометрию редактировать нельзя.",
  "spaceEnvelope.invalid": "Потолок должен находиться выше пола, а конёк между карнизами. Скатный потолок должен подниматься до своего конька.",
} satisfies Catalogue;
