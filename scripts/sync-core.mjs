#!/usr/bin/env node
/**
 * Vendor the core modules into the plugin package.
 *
 * `lib/` is the single source of truth (used by the CLI and the skill install).
 * The plugin ships its own copy because an installed plugin cannot reach a
 * skill directory that the user may not have. `test/plugin.test.mjs` fails if
 * the copies drift, so run this after touching lib/.
 *
 *   node scripts/sync-core.mjs           # write copies
 *   node scripts/sync-core.mjs --check   # verify only, exit 1 on drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const srcDir = path.join(root, 'lib');
const dstDir = path.join(root, 'plugin', 'dsh', 'lib');
const check = process.argv.includes('--check');

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.mjs')).sort();
const banner = '// Vendored copy of lib/%s — edit lib/ and run `node scripts/sync-core.mjs`.\n';

if (!check) fs.mkdirSync(dstDir, { recursive: true });

let drift = 0;
for (const file of files) {
  const src = fs.readFileSync(path.join(srcDir, file), 'utf8');
  const expected = banner.replace('%s', file) + src;
  const dstPath = path.join(dstDir, file);
  if (check) {
    const actual = fs.existsSync(dstPath) ? fs.readFileSync(dstPath, 'utf8') : '';
    if (actual !== expected) {
      console.error(`drift: plugin/dsh/lib/${file}`);
      drift++;
    }
  } else {
    fs.writeFileSync(dstPath, expected, 'utf8');
    console.log(`synced plugin/dsh/lib/${file}`);
  }
}

if (check) {
  if (drift) {
    console.error(`\n${drift} file(s) out of sync. Run: node scripts/sync-core.mjs`);
    process.exit(1);
  }
  console.log(`core in sync (${files.length} files)`);
}
