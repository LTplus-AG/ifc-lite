/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export {} // module boundary (stripped by transpiler)

// ─────────────────────────────────────────────────────────────────────────
// Construction schedule — build an IfcWorkSchedule + IfcTasks + sequences
//
// Two modes:
//   1) Attach a construction sequence to the CURRENTLY LOADED model.
//      The script reads CSV task rows (attached via the chat paperclip)
//      and creates IfcTasks whose products are resolved by name/type.
//
//   2) No model loaded — generate a standalone demo IFC file with a few
//      walls and a matching 4-task construction schedule.
//
// CSV expected columns (case-insensitive, any subset works):
//   id, name, start, finish, duration, predecessor, products, predefinedType,
//   isMilestone, isCritical, completion
//
// Dates are ISO 8601 (e.g. 2024-05-01T08:00:00).
// Durations are ISO 8601 (e.g. P5D, PT8H).
// `products` is a comma-separated list of IFC types (e.g. "IfcWall,IfcSlab")
// OR entity globalIds; elements matching each row are assigned to that task.
// `predecessor` is the `id` of the row that must finish before this one.
// ─────────────────────────────────────────────────────────────────────────

function toIso(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  // Accept "YYYY-MM-DD" → append midnight
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00`
  return s
}

function toBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
  return undefined
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

// Canonicalize a column name so "Start Date", "start_date" and "start" all match.
function findCol(cols: string[], ...aliases: string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, '')
  const wanted = aliases.map(norm)
  for (const c of cols) if (wanted.includes(norm(c))) return c
  return null
}

const files = bim.files.list()
const csvFile = files.find((f) => f.name.toLowerCase().endsWith('.csv'))

if (csvFile) {
  // ─── Mode 1: attach schedule to currently loaded model ────────────────
  const rows = bim.files.csv(csvFile.name) ?? []
  const cols = bim.files.csvColumns(csvFile.name)
  if (rows.length === 0) {
    console.warn(`[schedule] ${csvFile.name} has no rows`)
  } else {
    console.log(`[schedule] loading ${rows.length} tasks from ${csvFile.name}`)
  }

  const idCol = findCol(cols, 'id', 'taskid')
  const nameCol = findCol(cols, 'name', 'task', 'activity')
  const startCol = findCol(cols, 'start', 'startdate', 'schedulestart')
  const finishCol = findCol(cols, 'finish', 'end', 'enddate', 'schedulefinish')
  const durCol = findCol(cols, 'duration', 'scheduleduration')
  const predCol = findCol(cols, 'predecessor', 'depends', 'dependson')
  const productsCol = findCol(cols, 'products', 'type', 'entities', 'targets')
  const typeCol = findCol(cols, 'predefinedtype', 'kind')
  const mileCol = findCol(cols, 'ismilestone', 'milestone')
  const critCol = findCol(cols, 'iscritical', 'critical')
  const compCol = findCol(cols, 'completion', 'percentcomplete', 'progress')

  // Discover every loaded product once so we can resolve `products` values
  // (IFC type OR globalId substring) into a list of expressIds.
  const allProducts = bim
    .query()
    .byType(
      'IfcWall', 'IfcSlab', 'IfcColumn', 'IfcBeam', 'IfcRoof', 'IfcStair',
      'IfcDoor', 'IfcWindow', 'IfcRailing', 'IfcFooting', 'IfcCurtainWall',
      'IfcMember', 'IfcPlate', 'IfcFurnishingElement', 'IfcBuildingElementProxy',
    )
    .toArray()

  // Minimum character count before we fall back to a globalId prefix match;
  // avoids accidental wildcarding when the CSV column holds short tokens.
  const MIN_GID_PREFIX_LEN = 4

  function resolveProducts(spec: string | undefined): number[] {
    if (!spec) return []
    const parts = spec.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
    const ids = new Set<number>()
    for (const part of parts) {
      const upper = part.toUpperCase()
      if (upper.startsWith('IFC')) {
        // IFC type — match all loaded entities of that class
        for (const e of allProducts) {
          if (e.type.toUpperCase() === upper) ids.add(e.ref.expressId)
        }
      } else {
        // Exact globalId match, OR prefix match when the token is long enough
        // to uniquely identify an element (≥ 4 chars).
        for (const e of allProducts) {
          if (e.globalId === part) {
            ids.add(e.ref.expressId)
          } else if (part.length >= MIN_GID_PREFIX_LEN && e.globalId.startsWith(part)) {
            ids.add(e.ref.expressId)
          }
        }
      }
    }
    return Array.from(ids)
  }

  // We can't use bim.create on an existing model in this iteration — the
  // creator produces a fresh IFC file. So we log what *would* be created
  // and print a plan. The plan is directly feedable to a follow-up
  // save/export workflow.
  console.log('[schedule] plan:')
  for (const row of rows) {
    const id = idCol ? row[idCol] : '-'
    const name = nameCol ? row[nameCol] : '(unnamed)'
    const start = startCol ? toIso(row[startCol]) : undefined
    const finish = finishCol ? toIso(row[finishCol]) : undefined
    const dur = durCol ? row[durCol] : undefined
    const pred = predCol ? row[predCol] : undefined
    const prodSpec = productsCol ? row[productsCol] : undefined
    const prodIds = resolveProducts(prodSpec)
    const predefinedType = typeCol ? row[typeCol] : undefined
    const isMilestone = mileCol ? toBool(row[mileCol]) : undefined
    const isCritical = critCol ? toBool(row[critCol]) : undefined
    const completion = compCol ? toNumber(row[compCol]) : undefined
    console.log(
      `  • [${id}] ${name}  ${start ?? '?'} → ${finish ?? dur ?? '?'}  ` +
      `prod=${prodIds.length}  pred=${pred ?? '-'}  ` +
      `type=${predefinedType ?? '-'}  mile=${isMilestone ?? '-'}  ` +
      `crit=${isCritical ?? '-'}  comp=${completion ?? '-'}`,
    )
  }
  console.log(
    '[schedule] Attaching tasks to an existing IFC requires a separate ' +
    'mutation workflow — ask the assistant to wire the plan into a fresh ' +
    'IFC export using bim.create.* so the 4D Gantt panel can play it.',
  )
} else {
  // ─── Mode 2: generate a demo IFC with walls + a matching schedule ─────
  console.log('[schedule] No CSV attached — building demo model + schedule')

  const h = bim.create.project({ Name: 'Demo with schedule', Schema: 'IFC4' })
  const storey = bim.create.addIfcBuildingStorey(h, { Name: 'Ground', Elevation: 0 })

  const wallA = bim.create.addIfcWall(h, storey, {
    Name: 'Wall A', Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3,
  })
  const wallB = bim.create.addIfcWall(h, storey, {
    Name: 'Wall B', Start: [5, 0, 0], End: [5, 5, 0], Thickness: 0.2, Height: 3,
  })
  const wallC = bim.create.addIfcWall(h, storey, {
    Name: 'Wall C', Start: [5, 5, 0], End: [0, 5, 0], Thickness: 0.2, Height: 3,
  })
  const wallD = bim.create.addIfcWall(h, storey, {
    Name: 'Wall D', Start: [0, 5, 0], End: [0, 0, 0], Thickness: 0.2, Height: 3,
  })

  const schedule = bim.create.addIfcWorkSchedule(h, {
    Name: 'Construction schedule',
    StartTime: '2024-05-01T08:00:00',
    FinishTime: '2024-05-20T17:00:00',
    PredefinedType: 'PLANNED',
  })

  const tFoundation = bim.create.addIfcTask(h, {
    Name: 'Site preparation',
    PredefinedType: 'CONSTRUCTION',
    ScheduleStart: '2024-05-01T08:00:00',
    ScheduleFinish: '2024-05-03T17:00:00',
    ScheduleDuration: 'P3D',
    IsMilestone: false,
  })
  const tWallAB = bim.create.addIfcTask(h, {
    Name: 'Install walls A+B',
    PredefinedType: 'INSTALLATION',
    ScheduleStart: '2024-05-06T08:00:00',
    ScheduleFinish: '2024-05-10T17:00:00',
    ScheduleDuration: 'P5D',
  })
  const tWallCD = bim.create.addIfcTask(h, {
    Name: 'Install walls C+D',
    PredefinedType: 'INSTALLATION',
    ScheduleStart: '2024-05-13T08:00:00',
    ScheduleFinish: '2024-05-17T17:00:00',
    ScheduleDuration: 'P5D',
    IsCritical: true,
  })
  const tHandover = bim.create.addIfcTask(h, {
    Name: 'Handover',
    PredefinedType: 'CONSTRUCTION',
    ScheduleStart: '2024-05-20T08:00:00',
    ScheduleFinish: '2024-05-20T17:00:00',
    IsMilestone: true,
  })

  bim.create.assignTasksToWorkSchedule(h, schedule, [tFoundation, tWallAB, tWallCD, tHandover])
  bim.create.assignProductsToTask(h, tWallAB, [wallA, wallB])
  bim.create.assignProductsToTask(h, tWallCD, [wallC, wallD])

  bim.create.addIfcRelSequence(h, tFoundation, tWallAB, { SequenceType: 'FINISH_START', TimeLag: 'P2D' })
  bim.create.addIfcRelSequence(h, tWallAB, tWallCD, { SequenceType: 'FINISH_START' })
  bim.create.addIfcRelSequence(h, tWallCD, tHandover, { SequenceType: 'FINISH_START' })

  const result = bim.create.toIfc(h)
  console.log(`[schedule] generated ${result.stats.entityCount} entities (${result.stats.fileSize} bytes)`)
  bim.export.download(result.content, 'demo-with-schedule.ifc', 'model/ifc')
  console.log('[schedule] downloaded demo-with-schedule.ifc — open it in this viewer to see the 4D Gantt panel animate the construction.')
}
