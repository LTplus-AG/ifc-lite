/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The 4D / IfcTask Gantt panel's own chrome (#4918 slice): the toolbar
 * (playback, scrubber, schedule/speed/scale selects, undo/redo, discard),
 * the drag tooltip shown while dragging a bar, the work-plan summary
 * strip, the task-tree left pane, the height-slice strategy sub-panel, the
 * "Generate schedule" dialog and its Advanced disclosure, the animation
 * settings popover (including the per-task-type palette legend), and the
 * empty state shown when there is nothing to draw. Does not cover the
 * small `respectWorkCalendar` toggle button, which already has its own
 * catalogue (`gantt-work-calendar.en.ts`).
 */
export const scheduleEn = {
  // ── Toolbar (GanttToolbar.tsx) ──────────────────────────────────────
  'schedule.toolbar.jumpToStart': 'Jump to start',
  'schedule.toolbar.jumpToFinish': 'Jump to finish',
  'schedule.toolbar.play': 'Play',
  'schedule.toolbar.pause': 'Pause',
  'schedule.toolbar.playConstructionSequence': 'Play construction sequence',
  'schedule.toolbar.pauseConstructionSequence': 'Pause construction sequence',
  'schedule.toolbar.enableLoop': 'Enable loop',
  'schedule.toolbar.disableLoop': 'Disable loop',
  'schedule.toolbar.looping': 'Looping',
  'schedule.toolbar.oneShot': 'One-shot',
  'schedule.toolbar.playbackPosition': 'Playback position',
  'schedule.toolbar.allTasks': 'All tasks',
  'schedule.toolbar.simulationSpeed': 'Simulation speed',
  'schedule.toolbar.speedDaysPerSecond': '{value} d/s',
  'schedule.toolbar.speedWeeksPerSecond': '{value} w/s',
  'schedule.toolbar.speedMonthsPerSecond': '{value} mo/s',
  'schedule.toolbar.generateConstructionSchedule': 'Generate construction schedule',
  'schedule.toolbar.generateScheduleEllipsis': 'Generate schedule…',
  'schedule.toolbar.noSpatialHierarchy': 'No spatial hierarchy or geometry to generate from',
  'schedule.toolbar.importScheduleFromFile': 'Import schedule from file',
  'schedule.toolbar.importScheduleTooltip': 'Import schedule (MS Project XML or CSV)…',
  'schedule.toolbar.addTask': 'Add task',
  'schedule.toolbar.addTaskTooltip': 'Add task (after selection or at end)',
  'schedule.toolbar.undoScheduleEdit': 'Undo schedule edit',
  'schedule.toolbar.undoTooltip': 'Undo (Ctrl+Z)',
  'schedule.toolbar.redoScheduleEdit': 'Redo schedule edit',
  'schedule.toolbar.redoTooltip': 'Redo (Ctrl+Shift+Z)',
  'schedule.toolbar.discardedToast': {
    one: 'Discarded {formattedCount} pending task.',
    other: 'Discarded {formattedCount} pending tasks.',
  },
  'schedule.toolbar.discardPendingAriaLabel': {
    one: 'Discard {formattedCount} pending generated task',
    other: 'Discard {formattedCount} pending generated tasks',
  },
  'schedule.toolbar.discardPendingTooltip': {
    one: 'Discard {formattedCount} pending schedule task',
    other: 'Discard {formattedCount} pending schedule tasks',
  },
  'schedule.toolbar.noDates': 'No dates',
  'schedule.toolbar.noDatesTitle': 'No real dates — using synthetic range',
  'schedule.toolbar.scaleHour': 'Hour',
  'schedule.toolbar.scaleDay': 'Day',
  'schedule.toolbar.scaleWeek': 'Week',
  'schedule.toolbar.scaleMonth': 'Month',
  'schedule.toolbar.scaleYear': 'Year',

  // ── Drag tooltip (GanttDragTooltip.tsx) ─────────────────────────────
  'schedule.dragTooltip.shifting': 'Shifting',
  'schedule.dragTooltip.resizingStart': 'Resizing start',
  'schedule.dragTooltip.resizingFinish': 'Resizing finish',
  'schedule.dragTooltip.start': 'Start {value}',
  'schedule.dragTooltip.finish': 'Finish {value}',
  'schedule.dragTooltip.duration': 'Duration {days}d',
  'schedule.dragTooltip.hint': 'Shift = no snap · Esc = cancel',

  // ── Work-plan summary strip (GanttWorkPlanSummary.tsx) ──────────────
  'schedule.workPlanSummary.ariaLabel': 'Work plans',
  'schedule.workPlanSummary.heading': {
    one: 'Work plan',
    other: 'Work plans',
  },
  'schedule.workPlanSummary.planTitle': 'IfcWorkPlan {globalId}',
  'schedule.workPlanSummary.nestedAriaLabel': 'Nested work schedules',
  'schedule.workPlanSummary.schedulesList': 'Schedules: {names}',
  'schedule.workPlanSummary.noNestedSchedules': 'No nested schedules',
  'schedule.workPlanSummary.ungrouped': 'Ungrouped: {names}',

  // ── Task tree (GanttTaskTree.tsx) ───────────────────────────────────
  'schedule.taskTree.columnTask': 'Task',
  'schedule.taskTree.clearSelectionAriaLabel': 'Clear task selection',
  'schedule.taskTree.columnDuration': 'Duration',
  'schedule.taskTree.collapseAriaLabel': 'Collapse {label}',
  'schedule.taskTree.expandAriaLabel': 'Expand {label}',
  'schedule.taskTree.workCalendar': 'Work calendar: {name}',

  // ── Height-slice strategy sub-panel (HeightStrategyPanel.tsx) ───────
  'schedule.heightStrategy.title': 'Height-slice options',
  'schedule.heightStrategy.usesGeometry': 'Uses geometry, ignores spatial tree',
  'schedule.heightStrategy.sliceHeightLabel': 'Slice height',
  'schedule.heightStrategy.sliceHeightValue': '{value} m',
  'schedule.heightStrategy.description':
    'Elements whose geometry centroid Z falls inside the same band share a task. Typical storey heights are 3–4 m.',
  'schedule.heightStrategy.subdivideLabel': 'Subdivide each slice',
  'schedule.heightStrategy.optionNone': 'None',
  'schedule.heightStrategy.optionClass': 'Class',
  'schedule.heightStrategy.optionType': 'Type',
  'schedule.heightStrategy.optionName': 'Name',
  'schedule.heightStrategy.subgroupNone': 'One task per slice — every element in the band goes to that task.',
  'schedule.heightStrategy.subgroupClass': 'Split each slice by IFC class (IfcWall, IfcSlab, …).',
  'schedule.heightStrategy.subgroupType': 'Split each slice by the element’s type name (IfcRelDefinesByType target).',
  'schedule.heightStrategy.subgroupName': 'Split each slice by each element’s Name attribute.',

  // ── Generate dialog: Advanced disclosure (GenerateAdvancedPanel.tsx) ─
  'schedule.generateAdvanced.toggle': 'Advanced',
  'schedule.generateAdvanced.lagDaysLabel': 'Lag days (between groups)',
  'schedule.generateAdvanced.predefinedTypeLabel': 'PredefinedType',
  'schedule.generateAdvanced.scheduleNameLabel': 'Work schedule name',
  'schedule.generateAdvanced.scheduleNamePlaceholder': 'Construction schedule',
  'schedule.generateAdvanced.linkSequencesLabel': 'Link tasks with FS dependencies',
  'schedule.generateAdvanced.linkSequencesDescription': 'Adds IfcRelSequence edges between consecutive groups.',
  'schedule.generateAdvanced.skipEmptyLabel': 'Skip empty groups',
  'schedule.generateAdvanced.skipEmptyDescriptionElement': 'Ignore Z slices with no elements.',
  'schedule.generateAdvanced.skipEmptyDescriptionSpatial': 'Ignore storeys or buildings with no contained products.',
  'schedule.generateAdvanced.workPlanToggleLabel': 'Add an IfcWorkPlan container',
  'schedule.generateAdvanced.workPlanToggleDescription':
    'A standalone plan entity that groups the generated schedule(s). The grouping survives export and re-import.',
  'schedule.generateAdvanced.workPlanNameLabel': 'Work plan name',
  'schedule.generateAdvanced.workPlanNamePlaceholder': 'Project plan',

  // ── Generate dialog (GenerateScheduleDialog.tsx) ────────────────────
  'schedule.generateDialog.title': 'Generate schedule',
  'schedule.generateDialog.description':
    'Creates a work schedule with one task per group and assigns every product in that group to the task, so the 4D Gantt animation can reveal them as time advances.',
  'schedule.generateDialog.nothingToGroupByTitle': 'Nothing to group by',
  'schedule.generateDialog.nothingToGroupByDescription':
    'The loaded model has neither a spatial hierarchy nor visible geometry. Load an IFC with IfcBuildingStorey/IfcBuilding containers or meshed elements and try again.',
  'schedule.generateDialog.groupByLabel': 'Group by',
  'schedule.generateDialog.strategyStorey': 'Storey',
  'schedule.generateDialog.strategyStoreyDescription': 'Per IfcBuildingStorey',
  'schedule.generateDialog.strategyBuilding': 'Building',
  'schedule.generateDialog.strategyBuildingDescription': 'Per IfcBuilding',
  'schedule.generateDialog.strategyHeight': 'Height',
  'schedule.generateDialog.strategyHeightDescription': 'Slice by element Z',
  'schedule.generateDialog.spatialHierarchyMissing': 'Spatial hierarchy missing — only Height is available for this model.',
  'schedule.generateDialog.startDateLabel': 'Start date',
  'schedule.generateDialog.daysPerGroupLabel': 'Days per group',
  'schedule.generateDialog.orderLabel': 'Order',
  'schedule.generateDialog.orderBottomUp': 'Bottom-up',
  'schedule.generateDialog.orderBottomUpDescription': 'Site → ground → upper floors',
  'schedule.generateDialog.orderTopDown': 'Top-down',
  'schedule.generateDialog.orderTopDownDescription': 'Roof → upper floors → ground',
  'schedule.generateDialog.summaryHeading': 'Summary',
  'schedule.generateDialog.generatedLocally': 'Generated locally — not written to IFC',
  'schedule.generateDialog.summaryLineGroupsZero': { one: '{groups} tasks · {products} product · finishes {date}', other: '{groups} tasks · {products} products · finishes {date}' },
  'schedule.generateDialog.summaryLineGroupsOne': { one: '{groups} task · {products} product · finishes {date}', other: '{groups} task · {products} products · finishes {date}' },
  'schedule.generateDialog.summaryLineGroupsTwo': { one: '{groups} tasks · {products} product · finishes {date}', other: '{groups} tasks · {products} products · finishes {date}' },
  'schedule.generateDialog.summaryLineGroupsFew': { one: '{groups} tasks · {products} product · finishes {date}', other: '{groups} tasks · {products} products · finishes {date}' },
  'schedule.generateDialog.summaryLineGroupsMany': { one: '{groups} tasks · {products} product · finishes {date}', other: '{groups} tasks · {products} products · finishes {date}' },
  'schedule.generateDialog.summaryLineGroupsOther': { one: '{groups} tasks · {products} product · finishes {date}', other: '{groups} tasks · {products} products · finishes {date}' },
  'schedule.generateDialog.taskRangeSingle': 'First task: {first}',
  'schedule.generateDialog.taskRangeMultiple': 'First task: {first} · last: {last}',
  'schedule.generateDialog.noGroupsMatch':
    'No groups match the current options — tweak the strategy or disable "Skip empty groups".',
  'schedule.generateDialog.cancel': 'Cancel',
  'schedule.generateDialog.notAvailableForModel': 'Not available for this model',

  // ── Empty state (GanttEmptyState.tsx) ───────────────────────────────
  'schedule.emptyState.loadModelTitle': 'Load a model with IfcTasks',
  'schedule.emptyState.loadModelMessage':
    'Open an IFC file containing {task} or {schedule} entities to see the construction schedule here.',
  'schedule.emptyState.extracting': 'Extracting schedule…',
  'schedule.emptyState.extractionFailedTitle': 'Schedule extraction failed',
  'schedule.emptyState.extractionFailedHint': 'Re-open the model or inspect the browser console for details.',
  'schedule.emptyState.generateInstead': 'Generate a schedule instead',
  'schedule.emptyState.importEllipsis': 'Import schedule…',
  'schedule.emptyState.noTasksInScheduleTitle': 'No tasks in selected schedule',
  'schedule.emptyState.noTasksInScheduleMessage':
    "Choose {allTasks} or another schedule to see the model's other {task} records.",
  'schedule.emptyState.noScheduledTasksTitle': 'No scheduled tasks',
  'schedule.emptyState.noScheduledTasksMessage':
    'The loaded {workPlan} data is shown above, but it has no {task} records to draw on the Gantt timeline.',
  'schedule.emptyState.generateScheduleButton': 'Generate schedule',
  'schedule.emptyState.noScheduleFoundTitle': 'No schedule found',
  'schedule.emptyState.noScheduleFoundMessage':
    "This model doesn't define any {task}, {schedule}, or {sequence} entities. The Gantt panel powers itself from those entities and the products they control via {assigns}.",
  'schedule.emptyState.helperBoth':
    'Build a schedule by storey, building, or element-Z height slice, or import one from MS Project (MSPDI XML) or a Gantt CSV export.',
  'schedule.emptyState.helperGenerateOnly': 'Build a schedule by storey, building, or element-Z height slice.',
  'schedule.emptyState.helperImportOnly': 'Import one from MS Project (MSPDI XML) or a Gantt CSV export.',

  // ── Animation settings popover (AnimationSettingsPopover.tsx) ───────
  'schedule.animation.settingsAriaLabel': 'Animation settings',
  'schedule.animation.settingsTooltip': '4D animation settings',
  'schedule.animation.title': '4D animation',
  'schedule.animation.titleDescription': 'Drives viewport from the Gantt clock.',
  'schedule.animation.styleLabel': 'Style',
  'schedule.animation.minimalLabel': 'Minimal',
  'schedule.animation.minimalDescription': 'Visibility only — no colour',
  'schedule.animation.phasedLabel': 'Phased',
  'schedule.animation.phasedDescription': 'Task-type colour overlays',
  'schedule.animation.taskTypePaletteLabel': 'Task-type palette',
  'schedule.animation.paletteHint': "Click any swatch to change its colour. Hover a modified entry to reset just that one.",
  'schedule.animation.switchToPhasedCta': 'Switch to Phased to customize colours',
  'schedule.animation.switchToPhasedHint': 'Unlocks task-type palette editing, preparation ghost, and colour intensity.',
  'schedule.animation.timingLabel': 'Timing',
  'schedule.animation.hideUpcomingLabel': 'Hide upcoming products',
  'schedule.animation.hideUpcomingDescription': "Don't render work that hasn't started yet.",
  'schedule.animation.hideUnscheduledLabel': 'Hide unscheduled products',
  'schedule.animation.hideUnscheduledDescription':
    "Hide anything not assigned to a task — stops untasked geometry rendering as material default (often pure white).",
  'schedule.animation.animateDemolitionLabel': 'Animate demolition',
  'schedule.animation.animateDemolitionDescription': 'Remove products when demolition tasks complete.',
  'schedule.animation.colourOverlaysLabel': 'Colour overlays',
  'schedule.animation.colourByTaskTypeLabel': 'Colour by task type',
  'schedule.animation.colourByTaskTypeDescription': 'Paint the palette colour over active products.',
  'schedule.animation.preparationGhostLabel': 'Preparation ghost',
  'schedule.animation.preparationGhostDescription': 'Dim products inside the look-ahead window.',
  'schedule.animation.ghostColourLabel': 'Ghost colour',
  'schedule.animation.ghostColourDescription': 'Low-alpha dim applied to upcoming products.',
  'schedule.animation.tintCompletedLabel': 'Tint completed products',
  'schedule.animation.tintCompletedDescription':
    "Paint a neutral tint over built products so they're distinguishable from material-default geometry.",
  'schedule.animation.completedColourLabel': 'Completed colour',
  'schedule.animation.completedColourDescription': 'Low-alpha tint applied after a task finishes.',
  'schedule.animation.lookAheadWindowLabel': 'Look-ahead window',
  'schedule.animation.lookAheadWindowValue': '{days}d',
  'schedule.animation.colourIntensityLabel': 'Colour intensity',
  'schedule.animation.colourIntensityHint': '0% = no colour (equivalent to Minimal); 100% = solid paint.',
  'schedule.animation.modifiedTag': 'modified',
  'schedule.animation.resetDefaults': 'Reset defaults',
  'schedule.animation.resetToDefault': 'Reset to default',
  'schedule.animation.resetEntryAriaLabel': 'Reset {label} to default colour',
  'schedule.animation.swatchTitle': '{colorKey} — click to edit',
  'schedule.animation.swatchAriaLabel': 'Change colour for {colorKey}',

  // Per-IfcTaskTypeEnum palette legend labels.
  'schedule.animation.taskType.construction': 'Construction',
  'schedule.animation.taskType.installation': 'Installation',
  'schedule.animation.taskType.renovation': 'Renovation',
  'schedule.animation.taskType.maintenance': 'Maintenance',
  'schedule.animation.taskType.logistic': 'Logistic',
  'schedule.animation.taskType.operation': 'Operation',
  'schedule.animation.taskType.move': 'Move',
  'schedule.animation.taskType.attendance': 'Attendance',
  'schedule.animation.taskType.demolition': 'Demolition',
  'schedule.animation.taskType.dismantle': 'Dismantle',
  'schedule.animation.taskType.removal': 'Removal',
  'schedule.animation.taskType.disposal': 'Disposal',
  'schedule.animation.taskType.userDefined': 'User-defined',
  'schedule.animation.taskType.notDefined': 'Not defined',

  // ── GanttPanel.tsx (import-replace confirmation banner) ─────────────
  'schedule.panel.importReplaceWarning':
    'Importing "{fileName}" will replace the current schedule and its undo history.',
  'schedule.panel.replace': 'Replace',
  'schedule.panel.cancel': 'Cancel',
} as const;
