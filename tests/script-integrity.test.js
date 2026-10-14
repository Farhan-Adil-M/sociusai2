// Static checks for the scripts/ utilities. Importing these scripts directly
// would run them, so instead we verify structure: the import they need is
// present and the call site exists (protects against the ReferenceError class
// that broke `npm run reindex`).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('reindex script imports and calls assertConfig (regression for P1-1)', () => {
  const source = read('../scripts/reindex.js');
  assert.match(source, /import\s+\{[^}]*assertConfig[^}]*\}\s+from\s+'[^']*config\.js'/, 'assertConfig must be imported');
  assert.match(source, /^\s*assertConfig\(\);?\s*$/m, 'assertConfig must be called before work starts');
});
