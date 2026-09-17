/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Root-element namespace attributes for every XML file in a BCF archive.
 *
 * Shape matches what Solibri itself writes (#3612): only `xmlns:xsi`, plus
 * `xsi:noNamespaceSchemaLocation` naming the governing XSD. Solibri 26.6.1
 * silently imported zero topics from archives that lacked the schema location
 * on `bcf.version` and declared an extra `xmlns:xsd`; every archive it accepts
 * (its own, BIMcollab's, usBIM's) has the location and no `xmlns:xsd`.
 *
 * The buildingSMART schemas for both 2.1 and 3.0 declare no targetNamespace
 * and use the same file names (`version.xsd`, `project.xsd`, `markup.xsd`,
 * `visinfo.xsd`), so `noNamespaceSchemaLocation` with the bare file name is
 * correct for either version.
 */

const XSI_NAMESPACE = 'http://www.w3.org/2001/XMLSchema-instance';

/** The XSD that governs each BCF archive file. */
export type BcfSchemaFile = 'version.xsd' | 'project.xsd' | 'markup.xsd' | 'visinfo.xsd';

/**
 * Opening tag for a BCF root element: `xmlns:xsi` first, the element's own
 * attributes (already escaped, each with a leading space) next, the schema
 * location last -- the attribute order Solibri emits.
 */
export function bcfRootOpenTag(
  element: string,
  schemaFile: BcfSchemaFile,
  ownAttrs = '',
  selfClosing = false,
): string {
  return `<${element} xmlns:xsi="${XSI_NAMESPACE}"${ownAttrs} xsi:noNamespaceSchemaLocation="${schemaFile}"${selfClosing ? '/>' : '>'}`;
}
