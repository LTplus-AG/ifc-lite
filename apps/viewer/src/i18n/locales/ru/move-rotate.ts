/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const moveRotateRu = {
  "moveRotate.move.label": "Переместить",
  "moveRotate.move.hintBase": "Щёлкните по точке, от которой хотите переместиться, или введите расстояние",
  "moveRotate.move.hintTarget": "Щёлкните в нужном месте или введите расстояние и направление, затем нажмите Enter",
  "moveRotate.rotate.label": "Повернуть",
  "moveRotate.rotate.hintStart": "Нажмите на кольцо, чтобы начать поворот, или введите угол · P выбирает другой центр вращения",
  "moveRotate.rotate.hintAngle": "Нажмите, чтобы завершить поворот (шаг 15°, Alt позволяет свободно поворачивать), или введите угол",
  "moveRotate.rotate.hintPivot": "Укажите точку, вокруг которой нужно повернуть",
  "moveRotate.rotate.pivot": "Центр вращения",
  "moveRotate.rotate.pivotTitle": "Выбрать точку для поворота ({key})",
  "moveRotate.field.distance": "Расстояние",
  "moveRotate.field.direction": "Направление",
  "moveRotate.field.angle": "Угол",
  "moveRotate.noSelection": "Выберите, что переместить в первую очередь",
  "moveRotate.refused": "Часть выбранного нельзя переместить: её размещение не связано с размещением этажа",
  "moveRotate.tool.move": "Переместить",
  "moveRotate.tool.rotate": "Повернуть",
  "moveRotate.handle.move": "Переместить выделение ({key})",
  "moveRotate.handle.rotate": "Повернуть выбранное ({key})",
  "commands.model.move": "Переместить выбранное (рабочая область модели)",
  "commands.model.rotate": "Повернуть выбранное (рабочая область модели)",
  "commands.command.rotatePivot": "Выбрать точку, вокруг которой нужно совершить вращение",
} satisfies Catalogue;
