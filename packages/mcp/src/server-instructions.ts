/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** `initialize` instructions for the model server. Keep it under 4 KB and true to the registry. */
export const SERVER_INSTRUCTIONS = `
ifc-lite-mcp: IFC/BIM models (IFC2X3, IFC4, IFC4X3, IFC5/IFCX) as tools. Read, query, validate, edit and export building models.

Start here
- model_list, then model_info: what is loaded (schema, entity counts, units, georeferencing). model_load opens a file (mutate scope).
- Explore: spatial_hierarchy, storey_list, query_entities, count_entities, get_entity, get_entities_bulk, properties_unique, materials_list, classifications_list.
- Validate: model_audit, ids_validate, check_rules, clash_check, clash_matrix, georeferencing_check.
- Edit (mutate scope): entity_set_property, entity_set_attribute, entity_create, mutation_batch, place_door, place_window, storey_add. Edits stay pending until export_ifc or model_save writes them; mutation_diff lists them, mutation_undo reverts them.
- Export: export_ifc, export_csv, export_json, export_glb, export_obj, export_ifcx, export_usd, export_3dm.
- Model transforms (write a new file): model_merge, model_convert (schema version), model_extract (isolate products), model_anonymize, model_simplify, model_lod. Transform tools can replace an existing output file.
- Model health: model_stats, model_diagnose_geometry, model_delivery.
- Issues: bcf_topic_create, bcf_viewpoint_create, bcf_export.
- IDS authoring: ids_schema_search, ids_read, ids_apply_ops, ids_write, ids_lint.
- Compare two models: model_diff, quantity_diff.
- 3D viewer: viewer_ask, then viewer_open; viewer_colorize, viewer_isolate, viewer_fly_to, viewer_get_selection.

Conventions
- model_id: tools that act on one loaded model take an optional model_id. Omit it when one model is loaded; pass it when several are (MODEL_REQUIRED otherwise). BCF topics, draft layers and the two-model diffs (model_diff, quantity_diff) take no model_id.
- Entities: pass global_id (GlobalId) or express_id.
- Errors are tool results with isError=true, structuredContent.code (e.g. ENTITY_NOT_FOUND) and often a hint. Follow the hint and retry.
- Long calls send notifications/progress when the request carries _meta.progressToken.
- tools/list shows only the tools this session's scope allows (read, validate, mutate, export, admin). A --read-only server hides mutate tools.

Resources
- ifc-lite://server/manifest: settings, loaded models and the tool catalog (name, title, purpose, scope).
- ifc-lite://model/{model_id}/manifest, /spatial-tree, /materials, /property-sets.
- Entity by GlobalId: template ifc-lite://model/{model_id}/entity/{global_id} (resources/templates/list).
- ifc-lite://viewer/selection: subscribe to get every viewer pick.
`.trim();
