/* Rebuild the checked-in browser bundles from the editable component sources. */
const path = require('node:path');
const esbuild = require('esbuild');
const roots = (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean);
for (const [entry, output] of [
  ['source/nav.tsx', 'assets/glass-nav.js'],
  ['source/runway-loader.tsx', 'assets/runway-loader.js'],
  ['source/eye-entry.jsx', 'assets/eye-button.js'],
  ['source/orbit-entry.jsx', 'assets/orbit-gallery.js']
]) {
  esbuild.buildSync({
    absWorkingDir: __dirname,
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2020',
    outfile: output,
    nodePaths: roots,
    define: {'process.env.NODE_ENV': '"production"'},
    jsx: 'automatic'
  });
  console.log(`Built ${output}`);
}
