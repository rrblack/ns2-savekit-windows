'use strict';
// Installs the read-only Switch 2 save exporter into a NEW copy of your own
// BermTheSequel/ns2jb2 checkout at the pinned revision (see baseline.json).
//
//   node install.cjs ORIGINAL-HOST NEW-DESTINATION
//
// The original checkout is only read. Every one of its runtime files must match
// baseline.json byte for byte. Six of them are then changed by applying the
// unified diffs in patches/ (no fuzz, no offsets), and each result must match
// overlays.json before anything is written. The destination must not exist; it is
// claimed with an exclusive mkdir and never replaced. The offline fixture in
// tests/ then runs against the installed copy before OFFLINE PASS is printed.
// This repository redistributes none of the host's own files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const baseline = require('./baseline.json');
const expected = require('./overlays.json');
const overlays = Object.keys(expected);
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function run(args) {
  const r = spawnSync(process.execPath,args,{stdio:'inherit',windowsHide:true});
  if (r.error || r.status !== 0) throw r.error || Error('Node check failed: ' + args[0]);
}
function inside(parent, child) {
  const rel = path.relative(parent,child);
  return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+path.sep));
}

// Strict unified-diff application to a hash-verified input: every context and
// removed line must be present exactly where the hunk header says.
function applyPatch(name, original, patchText) {
  const lines = original.toString('utf8').split('\n');
  check(lines.pop() === '', 'Expected a trailing newline in ' + name);
  const patch = patchText.replace(/\r\n/g, '\n').split('\n');
  check(patch[0] === '--- a/' + name && patch[1] === '+++ b/' + name, 'Patch header does not name ' + name);
  const out = [];
  let at = 0, i = 2, hunks = 0;
  while (i < patch.length && patch[i] !== '') {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(patch[i++]);
    check(h, 'Malformed hunk header in patch for ' + name);
    const oldStart = Number(h[1]) - (h[2] === '0' ? 0 : 1);
    let oldCount = h[2] === undefined ? 1 : Number(h[2]);
    let newCount = h[4] === undefined ? 1 : Number(h[4]);
    check(oldStart >= at, 'Overlapping hunks in patch for ' + name);
    out.push(...lines.slice(at, oldStart));
    at = oldStart;
    while (oldCount || newCount) {
      const line = patch[i++];
      check(typeof line === 'string' && line.length, 'Truncated hunk in patch for ' + name);
      const text = line.slice(1);
      if (line[0] === ' ' || line[0] === '-') {
        check(lines[at] === text, 'Patch context differs at ' + name + ':' + (at + 1));
        at++; oldCount--;
        if (line[0] === ' ') { out.push(text); newCount--; }
      } else if (line[0] === '+') { out.push(text); newCount--; }
      else throw Error('Unexpected patch line in ' + name);
      check(oldCount >= 0 && newCount >= 0, 'Hunk length mismatch in patch for ' + name);
    }
    hunks++;
  }
  check(hunks > 0 && patch.slice(i).every(l => l === ''), 'Unexpected trailing patch content for ' + name);
  out.push(...lines.slice(at));
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}
function check(ok, message) { if (!ok) throw Error(message); }

function install(original, destination) {
  if (!original || !destination) throw Error('Usage: node install.cjs ORIGINAL-HOST NEW-DESTINATION');
  const src = fs.realpathSync(original);
  destination = path.resolve(destination);
  if (inside(src,destination) || inside(__dirname,destination))
    throw Error('Destination must be outside the original and package');
  // Resolve the nearest existing ancestor before creating any missing parents.
  let ancestor = path.dirname(destination);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const dst = path.join(fs.realpathSync(ancestor),path.relative(ancestor,destination));
  if (inside(src,dst) || inside(dst,src) || inside(__dirname,dst) || fs.existsSync(dst))
    throw Error('Use a fresh sibling directory outside the source and package: '+dst);
  const inputs = {};
  for (const [name, digest] of Object.entries(baseline)) {
    const file = path.join(src,name);
    if (!fs.lstatSync(file).isFile() || !inside(src,fs.realpathSync(file)))
      throw Error('Baseline file missing or redirected: '+name);
    const bytes = fs.readFileSync(file);
    if (sha(bytes) !== digest) throw Error('SHA-256 differs from reviewed Windows baseline: '+name);
    inputs[name] = bytes;
  }
  // Build every changed module in memory first; nothing is written on a mismatch.
  const changed = {};
  for (const name of overlays) {
    check(name in inputs, 'Patched file is not in the baseline: ' + name);
    const patched = applyPatch(name, inputs[name], fs.readFileSync(path.join(__dirname,'patches',name+'.patch'),'utf8'));
    check(sha(patched) === expected[name], 'Patched result differs from the reviewed module: ' + name);
    changed[name] = patched;
  }
  fs.mkdirSync(path.dirname(dst),{recursive:true});
  fs.mkdirSync(dst); // Atomic exclusive claim. Never adopt a pre-existing directory.
  try {
    const hashes = {};
    for (const [name, originalBytes] of Object.entries(inputs)) {
      const bytes = changed[name] || originalBytes;
      const file = path.join(dst,name);
      fs.mkdirSync(path.dirname(file), {recursive:true});
      fs.writeFileSync(file,bytes,{flag:'wx'});
      if (name.startsWith('engine/') && !name.startsWith('engine/lib/') && !name.endsWith('build-payload.cjs'))
        hashes[name.slice(7)] = sha(bytes);
    }
    fs.cpSync(path.join(__dirname,'backup'),path.join(dst,'backup'),{recursive:true});
    fs.writeFileSync(path.join(dst,'backup/runtime.json'), JSON.stringify(hashes,null,2)+'\n',{flag:'wx'});
    fs.cpSync(path.join(__dirname,'tests'),path.join(dst,'backup-tests'),{recursive:true});
    for (const file of Object.keys(inputs).filter(n=>n.endsWith('.cjs'))) run(['--check',path.join(dst,file)]);
    run([path.join(dst,'backup-tests/check.cjs'),src,dst]);
    console.log('OFFLINE PASS. Installed at',dst);
  } catch (e) {
    throw Error('Offline installation failed. Do not launch this incomplete copy at '+dst+'\n'+e.message);
  }
}
if (require.main === module)
  try { install(...process.argv.slice(2)); } catch(e) { console.error(e.message); process.exitCode = 1; }
module.exports = {applyPatch};
