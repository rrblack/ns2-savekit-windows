'use strict';
// Confirms an installed copy holds the six reviewed host modules (overlays.json).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const expected = require('../overlays.json');
const dir = process.argv[2];
if (!dir) { console.error('Usage: node tests/overlays.cjs INSTALLED-COPY'); process.exit(1); }
let bad = 0;
for (const [name, digest] of Object.entries(expected)) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex');
  console.log(got === digest ? 'ok  ' : 'BAD ', name);
  if (got !== digest) bad++;
}
process.exitCode = bad ? 1 : 0;
