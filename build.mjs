/**
 * build.mjs — produce public/index.html.
 *
 * Inlines app.js, the materialised seed, and the seed-rebasing function into
 * the template, so the result is a single self-contained file: it works served
 * by server.mjs, opened straight from disk, or published anywhere that renders
 * HTML.
 *
 *   node --no-warnings build.mjs
 *
 * public/index.html is committed on purpose (clone-and-open, no build step),
 * so it must never drift from its sources. `npm test` rebuilds it in memory
 * and fails if the committed copy is stale. Everything in the output is
 * deterministic except the single `window.GATHER_SEED = …;` line, whose dates
 * depend on when you build.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildSeed, rebaseSeed } from './server/seed-data.mjs';

const url = (p) => new URL(p, import.meta.url);

export const SEED_LINE_PREFIX = 'window.GATHER_SEED = ';

/** Render index.html without writing it. `from` pins the seed's clock. */
export async function renderIndex({ from = Date.now() } = {}) {
  const template = await readFile(url('./public/index.template.html'), 'utf8');
  const appJs = await readFile(url('./public/app.js'), 'utf8');

  // Guard against silently shipping a template that lost its markers.
  for (const token of ['__GATHER_SEED__', '__GATHER_REBASE__', '/*__APP_JS__*/']) {
    if (!template.includes(token)) throw new Error(`template is missing ${token}`);
  }

  const seed = { ...buildSeed({ from }), builtAt: from };

  // rebaseSeed is inlined by source text, so it must not close over anything
  // in its module. Prove it: rebuild it from source in an empty scope and
  // check it produces exactly what the real one does.
  const rebaseSrc = rebaseSeed.toString();
  let standalone;
  try {
    standalone = new Function(`return (${rebaseSrc});`)();
  } catch (err) {
    throw new Error(`rebaseSeed does not compile standalone: ${err.message}`);
  }
  const probe = from + 41 * 86400000;
  let a;
  try {
    a = JSON.stringify(standalone(seed, probe));
  } catch (err) {
    throw new Error(`rebaseSeed is not self-contained (${err.message}). It is inlined into the page by source text, so it cannot use anything defined outside its body.`);
  }
  if (a !== JSON.stringify(rebaseSeed(seed, probe))) {
    throw new Error('rebaseSeed behaves differently when inlined — it must be self-contained.');
  }

  // Function replacements: the payloads contain $ sequences that a string
  // replacement would interpret as capture-group references.
  const html = template
    .replace('__GATHER_SEED__', () => JSON.stringify(seed))
    .replace('__GATHER_REBASE__', () => rebaseSrc)
    .replace('/*__APP_JS__*/', () => appJs);

  return { html, seed, appJs };
}

/** Drop the one build-time-dependent line so two builds can be compared. */
export function withoutSeedLine(html) {
  return html.split('\n').filter((line) => !line.startsWith(SEED_LINE_PREFIX)).join('\n');
}

// Only write when run directly, so tests can import renderIndex.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { html, seed, appJs } = await renderIndex();
  await writeFile(url('./public/index.html'), html);
  const kb = (s) => `${Math.round(Buffer.byteLength(s) / 1024)} KB`;
  console.log(`[build] public/index.html  ${kb(html)}`);
  console.log(`[build]   app.js ${kb(appJs)} · seed ${seed.events.length} events, ${seed.users.length} users`);
}
