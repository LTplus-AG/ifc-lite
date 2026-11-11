/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralReviewRu = {
  "structuralReview.title": "Просмотреть предоставленный аналитический граф",
  "structuralReview.hint": "Проверяйте только предоставленную геометрию, закрепления и компоненты нагрузок. Создаются записи IFC; расчёт или проверка инженерного проекта не выполняется. Выберите операции, затем проверьте все изменения IFC перед применением.",
  "structuralReview.prepare": "Проверить выбранные операции расчётной модели",
  "structuralReview.references": "Исходный целевой объект: {target} · связанные записи: {related}",
  "structuralReview.acknowledgement": "Подтверждаю, что значения нагрузки и жёсткости заданы в исходных единицах модели. Преобразование или отсутствующее объявление единиц не подразумевается.",
  "structuralReview.previewUnavailable": "Предварительный просмотр аналитической геометрии здесь недоступен. Перед применением проверьте исходные записи IFC.",
  "structuralReview.population": "Проверено исходных записей {records} · создано {created} · изменено {modified} · удалено {deleted}. Идентификаторы создаваемых объектов IFC назначаются при применении.",
  "structuralReview.units": "Просмотреть заданные единицы измерения модели и недоступные определения",
  "structuralReview.nativeChanges": "Проверить изменения в исходном IFC, включая общие ссылки и удаления",
  "structuralReview.receiptProblem": "Изменения были применены, но их подтверждение не удалось сохранить. В истории изменений по-прежнему содержатся внесённые изменения.",
  "structuralReview.op.structural.analysis.create": "Создать аналитическую модель",
  "structuralReview.op.structural.member.create": "Создать аналитический стержневой элемент",
  "structuralReview.op.structural.connection.create": "Создать аналитическое точечное соединение",
  "structuralReview.op.structural.group.create": "Создать заданную группу нагрузок",
  "structuralReview.op.structural.pointAction.create": "Создать заданное точечное воздействие",
  "structuralReview.op.structural.linearAction.create": "Создать заданное линейное воздействие",
  "structuralReview.op.structural.member.connect": "Связать элемент и соединение",
  "structuralReview.op.structural.activity.connect": "Связать заданное действие с элементом",
  "structuralReview.op.structural.group.assign": "Добавить заданные объекты в группу",
  "structuralReview.derive.title": "Построить расчётную модель",
  "structuralReview.derive.hint": "Балки, колонны и стержни становятся стержневыми элементами, плиты и стены становятся пластинами по срединной плоскости; сходящиеся концы стержней образуют общий узел; фундаменты дают опоры. Каждый элемент расчётной модели связан со своим физическим элементом. Создаются записи IFC; проект не проверяется.",
  "structuralReview.derive.prepare": "Построить и проверить",
  "structuralReview.derive.acknowledgement": "Я проверил пропущенные элементы и предполагаемые опоры.",
  "structuralReview.derive.counts": "Стержней: {curveMembers} · пластин: {surfaceMembers} · узлов: {nodes} · опор: {supports}, из них предполагаемых: {guessedSupports} · записей IFC к созданию: {created}",
  "structuralReview.derive.assumed": "Элементов без значения LoadBearing, считающихся несущими: {count}.",
  "structuralReview.derive.skipped": "Пропущенные элементы ({count})",
  "structuralReview.derive.guessed": "Предполагаемые опоры в самых нижних узлах, так как фундаментов нет ({count})",
  "structuralReview.derive.unconnected": "Концы стержней, касающиеся элемента или пластины без соединения ({count})",
  "structuralReview.derive.existing": "У модели уже есть построенная расчётная модель (#{id}). Повторно она не строится.",
  "structuralReview.derive.nothing": "Нечего строить: ни один несущий элемент не удалось идеализировать, или у каждого уже есть расчётный аналог.",
  "structuralReview.derive.noModel": "Загрузите модель, чтобы построить её расчётную модель.",
  "structuralReview.derive.nodeAt": "Узел {node}: {position} м",
  "structuralReview.derive.endAt": "Узел {node}: {position} м, {landsOn} #{element}",
  "structuralReview.derive.more": "Не показано ещё {count}",
} satisfies Catalogue;
