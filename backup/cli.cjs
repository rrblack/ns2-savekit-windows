'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID, createHash} = require('node:crypto');
const {check, readJSON, spaces, scanSpace, attributeKey, folder, parseEntry, identity, useLive} = require('./live.cjs');
const {pullOne, verifyOne} = require('./archive.cjs');
const join = path.join;
const hash = b => createHash('sha256').update(b).digest('hex');

async function saveJSON(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value,null,2)+'\n', {flag:'wx'});
  await fs.rename(temp, file);
}
async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function validateInventory(inv) {
  check(inv.format === 1 && Array.isArray(inv.entries) && typeof inv.session === 'string' &&
    spaces.every(space => inv.spaces[space]), 'Incomplete inventory schema');
  const ids = new Set();
  for (const row of inv.entries) {
    check(/^[0-9a-f]{192}$/.test(row.raw) && spaces.includes(row.space) &&
      identity(parseEntry(Buffer.from(row.raw,'hex'), row.space)) === identity(row) &&
      !ids.has(folder(row)), 'Duplicate or invalid archive identity in inventory');
    ids.add(folder(row));
  }
  for (const space of spaces)
    check(inv.entries.filter(e=>e.space===space).length === inv.spaces[space].count,
      'Inventory count mismatch in space ' + space);
}
async function inventory(run, out) {
  await useLive(run, async live => {
    await fs.mkdir(path.dirname(out), {recursive:true});
    await fs.mkdir(out); // A snapshot never adopts or overwrites an existing folder.
    const inv = {format:1, at:new Date().toISOString(), session:live.session, run,
      sourceSha256:live.sourceSha256, spaces:{}, entries:[]};
    for (const space of spaces) {
      const scan = await scanSpace(live.s, live.root, live.oneHandle, space);
      inv.spaces[space] = {count:scan.entries.length, error:scan.error};
      inv.entries.push(...scan.entries);
      console.log('space',space,scan.entries.length,'rows',scan.error || 'enumerated');
      await saveJSON(join(out,'inventory.partial.json'), inv);
    }
    validateInventory(inv);
    await fs.rename(join(out,'inventory.partial.json'),join(out,'inventory.json'));
    const inventoryHash = hash(await fs.readFile(join(out,'inventory.json')));
    await saveJSON(join(out,'progress.json'), {inventoryHash,rows:{}});
    console.log(inv.entries.length,'archives listed in',out);
  });
}
async function loadSnapshot(out) {
  const bytes = await fs.readFile(join(out,'inventory.json'));
  const inv = JSON.parse(bytes);
  validateInventory(inv);
  const progress = readJSON(join(out,'progress.json'));
  check(progress.inventoryHash === hash(bytes) && progress.rows && typeof progress.rows === 'object',
    'Progress does not match this inventory');
  return {inv, progress};
}
function priority(e) {
  if (e.applicationId === '0x01006f8002326000') return 0;
  if (e.type === 3) return 1;
  if (e.type === 1) return 2;
  return [0,6].includes(e.type) ? 4 : 3;
}
async function exportStore(run, out, previousSnapshot) {
  await useLive(run, async live => {
    const {inv, progress} = await loadSnapshot(out);
    check(inv.run === run && inv.session === live.session && inv.sourceSha256 === live.sourceSha256,
      'Inventory belongs to another run. Use a fresh snapshot folder for a new boot.');
    const save = () => saveJSON(join(out,'progress.json'), progress);
    const old = previousSnapshot ? await loadSnapshot(previousSnapshot) : null;
    if (old) {
      check(previousSnapshot !== out && old.inv.session !== inv.session,
        'Carry-forward requires a separate snapshot from an earlier run of this console');
      const oldUsers = new Set(old.inv.entries.map(e => e.uid).filter(u => !/^0+$/.test(u)));
      check(inv.entries.some(e => oldUsers.has(e.uid)),
        'Cannot confirm a shared nonzero account UID across the two inventories');
    }

    const rows = [...inv.entries].sort((a,b) => priority(a)-priority(b));
    const counts = new Map();
    for (const e of rows) counts.set(attributeKey(e),(counts.get(attributeKey(e)) || 0)+1);
    for (const e of rows) {
      const key = folder(e), final = join(out,key);
      if (await exists(final)) {
        const prior = progress.rows[key];
        const origin = prior?.sourceSession || inv.session;
        const totals = await verifyOne(final, e, origin);
        progress.rows[key] = {state:'verified', sourceSession:origin, ...totals}; await save(); continue;
      }
      const previous = progress.rows[key];
      if (previous?.state === 'verified') throw Error('Previously verified archive missing: ' + key);
      if (previous) { console.log(key, previous.state, 'already recorded'); continue; }
      // Exact attributes select the archive; command 53 has no dynamic ID argument.
      if (counts.get(attributeKey(e)) !== 1 || e.rank > 1 || e.type > 7 ||
          (BigInt(e.applicationId) === 0n && BigInt(e.staticId) === 0n)) {
        progress.rows[key] = {state:'unsupported', error:'ambiguous or unrecognized archive attributes'};
        await save(); continue;
      }
      console.log('Reading',key,e.applicationId,'type',e.type,'uid',e.uid);
      const stage = await fs.mkdtemp(join(out,'.partial-'+key+'-'));
      const oldRow = old?.inv.entries.find(row => identity(row) === identity(e) && row.raw === e.raw);
      const oldResult = old?.progress.rows[key];
      const carry = oldRow && oldResult?.state === 'verified';
      const sourceSession = carry ? (oldResult.sourceSession || old.inv.session) : inv.session;
      progress.rows[key] = {state:'in-progress', sourceSession, stage:path.basename(stage)}; await save();
      try {
        if (carry) {
          const previous = join(previousSnapshot, key);
          await verifyOne(previous, e, sourceSession);
          for (const name of ['data','escaped','manifest.json'])
            await fs.cp(join(previous,name), join(stage,name), {recursive:true, force:false, errorOnExist:true});
          const totals = await verifyOne(stage, e, sourceSession);
          await fs.rename(stage, final);
          progress.rows[key] = {state:'verified', sourceSession, ...totals};
          await save();
          console.log(key, 'verified copy from earlier session', sourceSession);
          continue;
        }
        const res = await pullOne(live, e, stage, inv.session);
        if (res.state === 'exported') {
          const totals = await verifyOne(stage, e, inv.session);
          await fs.rename(stage, final);
          progress.rows[key] = {state:'verified', sourceSession, ...totals};
        } else if (res.state === 'refused') {
          await fs.rmdir(stage);
          progress.rows[key] = res;
        } else progress.rows[key] = {...res, stage:path.basename(stage)};
      } catch (error) {
        progress.rows[key] = {state:'stopped', error:error.message, stage:path.basename(stage)};
        await save(); throw error;
      }
      console.log(key, e.applicationId, 'type',e.type, progress.rows[key].state, progress.rows[key].error || '');
      await save();
    }
  });
}

async function verify(out) {
  const {inv, progress} = await loadSnapshot(out);
  const report = {session:inv.session, listed:inv.entries.length, verified:0,
    unavailableSpaces:spaces.filter(s=>inv.spaces[s].error).map(space=>({space,...inv.spaces[space]})), rows:[]};
  const expected = new Set(inv.entries.map(folder));
  const extra = (await fs.readdir(out)).filter(name => /^space-/.test(name) && !expected.has(name));
  report.unexpectedArchiveFolders = extra;
  for (const e of inv.entries) {
    const key = folder(e), rec = progress.rows[key] || {state:'pending'};
    let result = rec;
    try {
      if (await exists(join(out,key))) {
        const sourceSession = rec.sourceSession || inv.session;
        const totals = await verifyOne(join(out,key), e, sourceSession);
        result = {state:totals.files ? 'verified' : 'verified-empty', sourceSession, ...totals};
        report.verified++;
      } else if (rec.state === 'verified') throw Error('Verified archive folder is missing');
    } catch (err) { result = {state:'invalid', error:err.message}; }
    report.rows.push({folder:key, ...e, ...result});
  }
  await saveJSON(join(out,'verification.json'),report);
  for (const r of report.rows.filter(r=>!r.state.startsWith('verified')))
    console.log(r.folder, r.applicationId, r.state, r.error || r.stage || '');
  for (const s of report.unavailableSpaces) console.log('Inventory coverage unknown in space',s.space,s.error);
  console.log(report.verified + '/' + report.listed,'listed archives verified; see',join(out,'verification.json'));
  return report.verified === report.listed && report.listed > 0 && !report.unavailableSpaces.length && !extra.length;
}

async function main(args) {
  const [cmd,a,b] = args;
  if (cmd === 'verify' && args.length === 2) return verify(path.resolve(a));
  const carry = cmd === 'export' && args.length === 5 && args[3] === '--carry-from';
  check(['inventory','export'].includes(cmd) && (args.length === 3 || carry),
    'Usage: node backup/cli.cjs inventory|export RUN NEW-SNAPSHOT, or verify SNAPSHOT');
  const run = await fs.realpath(a), out = path.resolve(b);
  check(path.relative(path.resolve(__dirname,'..'),out).startsWith('..'+path.sep) ||
    path.isAbsolute(path.relative(path.resolve(__dirname,'..'),out)), 'Keep backups outside the engine');
  if (cmd === 'inventory') { await inventory(run,out); return true; }
  await exportStore(run,out,carry ? path.resolve(args[4]) : null);
  return verify(out);
}
if (require.main === module) main(process.argv.slice(2)).then(ok => { process.exitCode = ok ? 0 : 2; })
  .catch(e => { console.error('STOP:', e.message); process.exitCode = 1; });
module.exports = {main, verify};
