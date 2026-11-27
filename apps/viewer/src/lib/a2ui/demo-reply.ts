/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A recorded assistant reply for the A2UI demo (`?a2uiDemo=1`), written for
 * `public/samples/building-architecture.ifc`. Every number on the surface is a
 * query the viewer evaluates; the prose states none. `session.test.ts` parses it
 * with the real agent parser, so it cannot drift from the catalog.
 */

export const A2UI_DEMO_PROMPT = 'Give me an overview of the walls in this model.';

export const A2UI_DEMO_REPLY = `Here is an overview of the walls. Every number below is computed live from the loaded model.

<a2ui>
root = Column([stats, table, chart, legend, actions])
stats = StatGroup([{label: "Walls", query: {types: ["IfcWall"]}}, {label: "External walls", query: {types: ["IfcWall"], where: [{path: "Pset_WallCommon.IsExternal", op: "eq", value: true}]}, tone: "info"}, {label: "Wall volume", query: {types: ["IfcWall"]}, aggregate: "sum", path: "Qto_WallBaseQuantities.NetVolume", unit: "m³"}, {label: "Slabs", query: {types: ["IfcSlab"]}}])
table = EntityTable([{path: "name", label: "Wall"}, {path: "Pset_WallCommon.IsExternal", label: "External"}, {path: "Qto_WallBaseQuantities.NetVolume", label: "Net volume (m³)"}, {path: "material", label: "Material"}], {types: ["IfcWall"]}, title="Walls", sort={path: "Qto_WallBaseQuantities.NetVolume", dir: "desc"})
chart = GroupChart("type", {types: ["IfcWall", "IfcSlab", "IfcSpace", "IfcRoof"]}, kind="bar", title="Elements by type")
legend = ColorLegend("Pset_WallCommon.IsExternal", {types: ["IfcWall"]}, title="Colour walls by IsExternal")
actions = ActionBar(["isolate", "colorize", "flyTo", "exportCsv"], {types: ["IfcWall"]}, color="#e5484d", followUps=[{label: "Which walls are load-bearing?", prompt: "Which walls are load-bearing?"}])
</a2ui>

Click a row to select that wall in 3D, or use the buttons to isolate, colour or export all of them.`;
