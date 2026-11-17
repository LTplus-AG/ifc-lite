/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { operation, emptySchema } from './contract';
const metadata = (id: string, owner: string, description: string) => ({
  id, owner, description, effects: ['read'] as const, capability: 'read' as const, implementation: 'sdk' as const,
});
export const readOperations = [
  operation(metadata('schedule.tasks', 'gantt', 'Read effective IFC tasks, including unsaved native changes.'), emptySchema, (_, c) => c.model.bim.schedule.tasks(c.model.id)),
  operation(metadata('schedule.containers', 'gantt', 'Read IfcWorkSchedule and IfcWorkPlan containers.'), emptySchema, (_, c) => c.model.bim.schedule.workSchedules(c.model.id)),
  operation(metadata('schedule.sequences', 'gantt', 'Read IfcRelSequence dependencies.'), emptySchema, (_, c) => c.model.bim.schedule.sequences(c.model.id)),
  operation(metadata('cost.schedules', 'cost', 'Read effective IFC cost schedules.'), emptySchema, (_, c) => c.model.bim.cost.schedules(c.model.id)),
  operation(metadata('cost.items', 'cost', 'Read effective IFC cost items.'), emptySchema, (_, c) => c.model.bim.cost.items(c.model.id)),
  operation(metadata('cost.values', 'cost', 'Read effective IFC cost values.'), emptySchema, (_, c) => c.model.bim.cost.values(c.model.id)),
  operation(metadata('structural.models', 'model', 'Read IfcStructuralAnalysisModel records.'), emptySchema, (_, c) => c.model.bim.structural.analysisModels(c.model.id)),
  operation(metadata('structural.members', 'model', 'Read structural members.'), emptySchema, (_, c) => c.model.bim.structural.members(c.model.id)),
  operation(metadata('structural.connections', 'model', 'Read structural connections.'), emptySchema, (_, c) => c.model.bim.structural.connections(c.model.id)),
  operation(metadata('structural.activities', 'model', 'Read structural activities.'), emptySchema, (_, c) => c.model.bim.structural.activities(c.model.id)),
  operation(metadata('structural.loadGroups', 'model', 'Read structural load groups.'), emptySchema, (_, c) => c.model.bim.structural.loadGroups(c.model.id)),
  operation(metadata('structural.resultGroups', 'model', 'Read structural result groups.'), emptySchema, (_, c) => c.model.bim.structural.resultGroups(c.model.id)),
  operation(metadata('lens.presets', 'lens', 'Read built-in lens definitions.'), emptySchema, (_, c) => c.model.bim.lens.presets()),
  operation(metadata('clash.presets', 'clash', 'Read native discipline-pair clash presets.'), emptySchema, (_, c) => c.model.bim.clash.presets()),
];
