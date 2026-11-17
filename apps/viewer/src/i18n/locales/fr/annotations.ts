/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const annotationsFr = {
  "annotations.dropInput.ariaLabel": "Nouvelle annotation",
  "annotations.dropInput.promptLabel": "Qu'est-ce qui mérite d'être noté ?",
  "annotations.dropInput.placeholder": "Une note courte : signaler un défaut, poser une question, laisser du contexte…",
  "annotations.dropInput.keyHints": "⏎ enregistrer · ⇧⏎ nouvelle ligne · esc annuler",
  "annotations.dropInput.cancelButton": "Annuler",
  "annotations.dropInput.dropPinButton": "Placer l'épingle",
  "annotations.layer.ariaLabel": "Calque des annotations",
  "annotations.layer.emptyNotePreview": "(note vide)",
  "annotations.pin.ariaLabelWithPreview": "Annotation {index} : {preview}",
  "annotations.pin.ariaLabelNoPreview": "Annotation n° {index}",
  "annotations.popover.ariaLabel": "Annotation",
  "annotations.popover.headerFallbackLabel": "Annotation",
  "annotations.popover.closeButtonTitle": "Fermer",
  "annotations.popover.placeholder": "Note sur ce point…",
  "annotations.popover.keyHints": "⏎ enregistrer · ⇧⏎ nouvelle ligne · esc annuler",
  "annotations.popover.cancelButton": "Annuler",
  "annotations.popover.saveButton": "Enregistrer",
  "annotations.popover.emptyNoteHint": "(aucune note : cliquez sur l'icône du crayon pour en ajouter une)",
  "annotations.popover.editedSuffix": "· modifiée",
  "annotations.popover.editButtonTitle": "Modifier la note",
  "annotations.popover.deleteButtonTitle": "Supprimer l'annotation",
  "annotations.popover.relativeJustNow": "à l'instant",
  "annotations.popover.relativeMinutesAgo": "il y a {count} min",
  "annotations.popover.relativeHoursAgo": "il y a {count} h",
  "annotations.popover.relativeDaysAgo": "il y a {count} j",
} satisfies Catalogue;
