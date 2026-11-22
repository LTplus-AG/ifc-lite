/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Catalog instructions the agent SDK places in the prompt. Every example here
 * is parsed by `catalog.test.ts`, so an example that stops compiling fails CI
 * instead of teaching the model a broken shape.
 */

export const IFC_EXPRESS_EXAMPLES: readonly { title: string; source: string }[] = [
  {
    title: 'Doors missing a fire rating, with 3D actions',
    source: `root = Column([summary, table, actions])
summary = StatGroup([{label: "Doors without FireRating", query: {types: ["IfcDoor"], where: [{path: "Pset_DoorCommon.FireRating", op: "missing"}]}, tone: "warn"}, {label: "All doors", query: {types: ["IfcDoor"]}}])
table = EntityTable([{path: "name", label: "Door"}, {path: "storey"}, {path: "Pset_DoorCommon.IsExternal", label: "External"}], {types: ["IfcDoor"], where: [{path: "Pset_DoorCommon.FireRating", op: "missing"}]}, groupBy="storey")
actions = ActionBar(["isolate", "colorize", "flyTo", "exportCsv"], {types: ["IfcDoor"], where: [{path: "Pset_DoorCommon.FireRating", op: "missing"}]}, color="#e5484d", followUps=[{label: "Which rating should they have?", prompt: "Suggest fire ratings for these doors based on their location"}])`,
  },
  {
    title: 'Element mix by storey',
    source: `root = Card(body)
body = Column([chart, legend])
chart = GroupChart("storey", {types: ["IfcWall", "IfcSlab", "IfcColumn", "IfcBeam"]}, kind="bar", title="Structural elements per storey")
legend = ColorLegend("type", {types: ["IfcWall", "IfcSlab", "IfcColumn", "IfcBeam"]}, title="Colour by type")`,
  },
  {
    title: 'Ask the user to narrow a question',
    source: `root = Column([question, picker, go])
question = Text("Which element types should I check?")
picker = ChoicePicker("Types", "multipleSelection", [{label: "Walls", value: "IfcWall"}, {label: "Doors", value: "IfcDoor"}, {label: "Windows", value: "IfcWindow"}], $/pick)
go = Button(Text("Check"), "primary", Event("ask", {prompt: "Check the selected element types", types: $/pick}))
$/pick = ["IfcDoor"]`,
  },
];

export const IFC_CATALOG_INSTRUCTIONS = `This catalog renders inside an IFC/BIM viewer that has building models loaded.

## IFC rules

1. Never type counts, names, quantities or other model facts into Text. Put them in IFC components: give EntityTable, EntityList, StatGroup, GroupChart and ColorLegend a query, and the viewer computes the real values. If a script already computed data, bind to it ($/path) instead.
2. A query is {types, where, storey, modelId, limit}. types are IFC class names (IfcDoor, IfcWall, IfcSpace). A where condition is {path, op, value}; paths are name, type, storey, material, an IFC attribute (Tag, PredefinedType) or Pset.Property (Pset_WallCommon.IsExternal, Qto_SpaceBaseQuantities.NetFloorArea). ops: eq, neq, contains, gt, gte, lt, lte, exists, missing.
3. Entity references are "modelId:expressId" strings. Use EntityCard("selection") for whatever the user has selected.
4. Offer an ActionBar under results so the user can isolate, colour or frame them in 3D. exportCsv only runs when the user clicks it.
5. Use Event("ask", {prompt: "..."}) on buttons that should continue the conversation. Other event names are reported to you as the user's action.
6. Keep surfaces small: one summary row, one table or chart, one action bar. Write the explanation as normal text outside the block.

## Examples

${IFC_EXPRESS_EXAMPLES.map((e, i) => `Example ${i + 1}: ${e.title}\n<a2ui>\n${e.source}\n</a2ui>`).join('\n\n')}
`;
