/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralDeriveRu = {
  "structuralDerive.hint": "Балки, колонны и стержни становятся стержневыми элементами, плиты и стены становятся пластинами по срединной плоскости; сходящиеся концы стержней образуют общий узел; фундаменты дают опоры. Каждый элемент расчётной модели связан со своим физическим элементом. Создаются записи IFC; проект не проверяется.",
  "structuralDerive.prepare": "Построить и проверить",
  "structuralDerive.acknowledgement": "Я проверил пропущенные элементы и предполагаемые опоры.",
  "structuralDerive.counts": "Стержней: {curveMembers} · пластин: {surfaceMembers} · узлов: {nodes} · опор: {supports}, из них предполагаемых: {guessedSupports} · записей IFC к созданию: {created}",
  "structuralDerive.assumed": "Элементов без значения LoadBearing, считающихся несущими: {count}.",
  "structuralDerive.skipped": "Пропущенные элементы ({count})",
  "structuralDerive.guessed": "Предполагаемые опоры в самых нижних узлах, так как фундаментов нет ({count})",
  "structuralDerive.unconnected": "Узлы, касающиеся элемента или пластины без соединения ({count})",
  "structuralDerive.existing": "В этой модели уже есть расчётная модель ({ids}). Рядом с ней ничего не выводится.",
  "structuralDerive.nothing": "Нечего строить: ни один несущий элемент не удалось идеализировать, или у каждого уже есть расчётный аналог.",
  "structuralDerive.noModel": "Загрузите модель, чтобы построить её расчётную модель.",
  "structuralDerive.nodeAt": "Узел {node}: {position} м",
  "structuralDerive.endAt": "Узел {node}: {position} м, {landsOn} #{element}",
  "structuralDerive.more": "Не показано ещё {count}",
  "structuralDerive.model": "Модель: {name}",
  "structuralDerive.moved": "Концы стержней, сдвинутые вдоль своей оси для образования узла ({count})",
  "structuralDerive.movedRow": "#{element} {end}: {distance} м до #{to}",
  "structuralDerive.free": "Свободные концы стержней без другого стержня и опоры ({count})",
  "structuralDerive.end.start": "начало",
  "structuralDerive.end.end": "конец",
  "structuralDerive.reason.already-idealised": "уже есть расчётный аналог",
  "structuralDerive.reason.not-load-bearing": "не несущий",
  "structuralDerive.reason.load-bearing-unknown": "нет значения LoadBearing",
  "structuralDerive.reason.no-idealisable-shape": "форму нельзя идеализировать",
  "structuralDerive.reason.shorter-than-tolerance": "короче допуска",
  "structuralDerive.reason.footing-without-member-end": "на этом фундаменте нет концов стержней",
  "structuralDerive.landsOn.member-interior": "на стержне",
  "structuralDerive.landsOn.surface-member": "на пластине",
} satisfies Catalogue;
