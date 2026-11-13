/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Catalogue } from '../../registry';

export const clashQualityRu = {
  'clashQuality.detectionExclusions': 'Исключения проёмов и несущих их элементов при обнаружении: {value}',
  'clashQuality.enabled': 'Включены',
  'clashQuality.disabled': 'Отключены',
  'clashQuality.title': 'Критерии качества',
  'clashQuality.configure': 'Настроить критерии качества',
  'clashQuality.clash': 'Проверки коллизий',
  'clashQuality.duplicates': 'Проверки дубликатов',
  'clashQuality.minimum': 'Минимальная доля объектов без замечаний, %',
  'clashQuality.label': 'Название категории',
  'clashQuality.color': 'Цвет категории',
  'clashQuality.newCategory': 'Новая категория',
  'clashQuality.add': 'Добавить категорию',
  'clashQuality.remove': 'Удалить категорию',
  'clashQuality.save': 'Сохранить пороги',
  'clashQuality.saved': 'Пороги критериев качества сохранены',
  'clashQuality.failed': 'Не удалось сохранить пороги критериев качества',
  'clashQuality.invalid': 'Начните с 0 %, задайте возрастающие минимумы до 100 % и название каждой категории.',
  'clashQuality.policy': 'Объекты без замечаний — это уникальные проверенные объекты без обнаруженных проблем. Учитываются оба объекта каждой пары; каждый объект считается один раз. Исключения результатов, статус проверки и фильтры отображения не меняют оценку. Исключения проёмов и несущих их элементов при обнаружении продолжают действовать. Проверки дубликатов учитывают все задействованные объекты, а не только лишние копии.',
  'clashQuality.counts': 'Проверено: {checked} · Затронуто: {affected}',
  'clashQuality.metric': 'Объекты без обнаруженных проблем',
  'clashQuality.not-evaluated': 'Не оценено',
  'clashQuality.unavailable': 'Данные об охвате проверки недоступны',
  'clashQuality.incomplete': 'Неполная проверка',
  'clashQuality.outdated': 'Устаревшая проверка',
  'clashQuality.document': 'Добавить критерии качества в документацию',
  'clashQuality.documentFailed': 'Не удалось сохранить документ критериев качества',
  'clashQuality.models': 'Модели: {models}',
  'clashQuality.tolerance': 'Допуск: {tolerance} м',
  'clashQuality.clearance': 'Зазор: {clearance} м',
  'clashQuality.captured': 'Сохранено: {when}',
  'clashQuality.revision': 'Редакция изменений модели: {revision}',
  'clashQuality.unknown': 'Неизвестно',
} satisfies Catalogue;
