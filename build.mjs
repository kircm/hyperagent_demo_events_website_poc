/**
 * build.mjs — produce public/index.html.
 *
 * Inlines app.js and the materialised seed into the template so the result is
 * a single self-contained file: it works served by server.mjs, opened from
 * disk, or pasted anywhere that renders HTML.
 *
 *   node --no-warnings build.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { buildSeed } from './server/seed-data.mjs';

const url = (p) => new URL(p, import.meta.url);

const template = await readFile(url('./public/index.template.html'), 'utf8');
const appJs = await readFile(url('./public/app.js'), 'utf8');
const seed = buildSeed();

// Guard against silently shipping a template that lost its markers.
for (const token of ['__GATHER_SEED__', '/*__APP_JS__*/']) {
  if (!template.includes(token)) throw new Error(`template is missing ${token}`);
}

// Function replacements: the payloads contain $ sequences that a string
// replacement would interpret as capture-group references.
const html = template
  .replace('__GATHER_SEED__', () => JSON.stringify(seed))
  .replace('/*__APP_JS__*/', () => appJs);

await writeFile(url('./public/index.html'), html);

const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
console.log(`[build] public/index.html  ${kb(html)}`);
console.log(`[build]   app.js ${kb(appJs)} · seed ${seed.events.length} events, ${seed.users.length} users`);
