/** The package declares ESM through `module` but points Node's `main` at a UMD
 * build under type:module. Import its actual ESM entry for both native hosts. */
declare module 'svg2pdf.js/dist/svg2pdf.es.min.js' {
  export { svg2pdf } from 'svg2pdf.js';
}
