import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../../apps/viewer/package.json', import.meta.url));
/** PDF path bounds in physical mm, after the PDF graphics transform. Text is excluded. */
export async function pdfPathExtents(bytes) {
  const { getDocument, OPS, Util } = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')));
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await loading.promise;
  const paths = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      let matrix = [1,0,0,1,0,0]; const stack = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        const op = ops.fnArray[i], args = ops.argsArray[i];
        if (op === OPS.save) stack.push([...matrix]);
        else if (op === OPS.restore) matrix = stack.pop() ?? [1,0,0,1,0,0];
        else if (op === OPS.transform) matrix = Util.transform(matrix, args);
        else if (op === OPS.constructPath) {
          // PDF.js 6 exposes the path's min/max as its fourth argument.
          const bounds = args[3];
          if (!bounds || bounds.length !== 4) continue;
          const points = [[bounds[0],bounds[1]],[bounds[0],bounds[3]],[bounds[2],bounds[1]],[bounds[2],bounds[3]]]
            .map(([x,y]) => [matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]]);
          paths.push({ page: n, widthMm: (Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0])))*25.4/72,
            heightMm: (Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1])))*25.4/72 });
        }
      }
    }
    return paths;
  } finally { await loading.destroy(); }
}
