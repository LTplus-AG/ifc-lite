/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const terrainImageryRu = {
  "terrainImagery.heading": "Изображения местности",
  "terrainImagery.none": "Изображение не наложено. Перетащите GeoTIFF или PNG/JPEG вместе с файлом привязки и .prj в средство просмотра, чтобы наложить изображение на этот рельеф.",
  "terrainImagery.source": "Источник",
  "terrainImagery.sourceTiles": "{name} (тайлы карты: только для просмотра, никогда не экспортируются)",
  "terrainImagery.crs": "CRS изображения",
  "terrainImagery.crsReprojected": "{image}, перепроецировано в {terrain}",
  "terrainImagery.gsd": "Размер пикселя на местности",
  "terrainImagery.gsdValue": "{gsd} {unit} на пиксель (как отображается)",
  "terrainImagery.covered": "Покрыто",
  "terrainImagery.coveredValue": "{percent} % (вершин {covered} из {total})",
  "terrainImagery.tiles.viewerOnly": "Тайлы карты накладываются только в просмотрщике; они никогда не записываются в экспортируемые файлы.",
  "terrainImagery.tiles.kind": "Сервис",
  "terrainImagery.tiles.kindXyz": "Тайлы XYZ",
  "terrainImagery.tiles.kindWms": "WMS",
  "terrainImagery.tiles.template": "Шаблон URL тайла ({z}/{x}/{y})",
  "terrainImagery.tiles.templatePlaceholder": "https://tile.example.org/{z}/{x}/{y}.png",
  "terrainImagery.tiles.wmsUrl": "Эндпоинт WMS",
  "terrainImagery.tiles.wmsPlaceholder": "https://wms.example.org/service",
  "terrainImagery.tiles.zoom": "Масштаб",
  "terrainImagery.tiles.layers": "Слои",
  "terrainImagery.tiles.resolution": "Расстояние на местности на пиксель",
  "terrainImagery.tiles.drape": "Наложить тайлы на рельеф",
  "terrainImagery.tiles.fetching": "Получение…",
  "terrainImagery.tiles.refused": "Тайлы не наложены на рельеф: {reason}",
} satisfies Catalogue;
