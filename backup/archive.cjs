'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {build} = require('./vendor/save-attr.cjs');
const tree = require('./vendor/save-tree.cjs');
const {check, identity, hexResult, readJSON} = require('./live.cjs');

const portable = name => !/[<>:"|?*\x00-\x1f\\/]/u.test(name) && !/[. ]$/u.test(name) &&
  !/^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?:\.|$)/iu.test(name);
function remoteParts(full) {
  check(typeof full === 'string' && full.startsWith('/'), 'Invalid archive path');
  const parts = full.slice(1).split('/');
  check(parts.every(p => p && !['.','..'].includes(p) && !p.includes('\\') && !p.includes('\0') &&
    !p.includes('\ufffd')), 'Unrepresentable or invalid remote path ' + full);
  return parts;
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function diskName(full, directory, stage, used, parents) {
  const parts = remoteParts(full), relative = full.slice(1), parent = full.slice(0, full.lastIndexOf('/'));
  const key = relative.normalize('NFC').toUpperCase();
  const normal = (!parent || parents.has(parent)) && !used.has(key) && parts.every(portable) &&
    path.join(stage, 'data', relative).length < 240;
  if (normal) {
    used.add(key);
    if (directory) parents.add(full);
    return 'data/' + relative;
  }
  if (directory) return null; // recorded logically, including empty directories
  return 'escaped/' + crypto.createHash('sha256').update(full).digest('hex');
}
async function pullOne({s, root, oneHandle, filesystem}, row, stage, session) {
  const input = build({space:row.space, type:row.type, uid:Buffer.from(row.uid,'hex'),
    rank:row.rank, index:row.index, staticId:BigInt(row.staticId), referenceId:BigInt(row.applicationId)});
  const open = await s.ipc('OpenReadOnlySaveDataFileSystem', root, 53, input);
  if (open.result) return {state:'refused', error:hexResult(open.result)};
  const save = oneHandle(open);
  const used = new Set(), parents = new Set(), paths = new Set();
  let lastProgress = Date.now();
  const m = {format:1, session, capturedAt:new Date().toISOString(), source:row, directories:[], entries:[], files:0, bytes:0, partial:false, failed:[]};
  const reserve = (full, dir) => {
    check(!paths.has(full), 'Duplicate directory entry ' + full);
    paths.add(full);
    return diskName(full, dir, stage, used, parents);
  };
  try {
    await fsp.mkdir(path.join(stage, 'data'));
    await fsp.mkdir(path.join(stage, 'escaped'));
    const api = {list: async (h, dir, limit) => {
      try { return await filesystem.listDirectory(s, h, dir, limit); }
      catch (err) {
        if (err.message !== 'Directory read failed' && !/^Directory exceeds the .*probe limit$/.test(err.message)) throw err;
        m.failed.push({path:dir, error:err.message});
        return [];
      }
    }};
    await tree.walk(save, '/', api, {
      directory: async full => {
        const local = reserve(full, true);
        if (local) await fsp.mkdir(path.join(stage, local));
        m.directories.push({path:full, local});
      },
      file: async (full, e) => {
        check(tree.isFile(e), 'Unknown directory entry type for ' + full);
        const local = reserve(full, false);
        const opened = await filesystem.openFile(s, save, full);
        if (opened.result) { m.failed.push({path:full, error:hexResult(opened.result)}); return; }
        try {
          const size = Number(await filesystem.fileSize(s, opened.handle));
          check(Number.isSafeInteger(size) && size >= 0 && BigInt(size) === BigInt(e.size),
            'File size disagrees with directory entry: ' + full);
          const disk = await fsp.open(path.join(stage, local), 'wx');
          const hash = crypto.createHash('sha256');
          try {
            for (let offset = 0; offset < size;) {
              const n = Math.min(0x40000, size-offset);
              const bytes = await filesystem.readFile(s, opened.handle, offset, n);
              check(bytes.length === n, 'Short console read: ' + full);
              const written = await disk.write(bytes, 0, n, offset);
              check(written.bytesWritten === n, 'Short PC write: ' + full);
              hash.update(bytes); offset += n;
              if (Date.now() - lastProgress >= 10000) {
                console.log(full, offset + '/' + size, 'bytes');
                lastProgress = Date.now();
              }
            }
            await disk.sync();
          } finally { await disk.close(); }
          m.entries.push({path:full, local, size, sha256:hash.digest('hex')});
          m.files++; m.bytes += size;
        } catch (err) {
          if (err.message !== 'File size failed' && !/^File read failed: [0-9]+$/.test(err.message)) throw err;
          m.failed.push({path:full, error:err.message});
        } finally { await s.close(opened.handle); }
      }
    });
  } finally { await s.close(save); }
  m.partial = m.failed.length > 0;
  await fsp.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(m,null,2)+'\n', {flag:'wx'});
  return {state:m.partial ? 'partial' : 'exported', files:m.files, bytes:m.bytes, failed:m.failed};
}

// Enumerate the PC archive independently; refuse links, missing/extra files and malformed manifests.
async function verifyOne(dir, row, session) {
  check((await fsp.lstat(dir)).isDirectory(), 'Archive folder is missing or is a link');
  const files = new Set(), dirs = new Set();
  async function walk(folder, prefix) {
    for (const entry of await fsp.readdir(folder, {withFileTypes:true})) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) { dirs.add(rel); await walk(path.join(folder, entry.name), rel+'/'); }
      else { check(entry.isFile(), 'Unexpected link or special file ' + rel); files.add(rel); }
    }
  }
  await walk(dir, '');
  check(files.delete('manifest.json') && dirs.delete('data') && dirs.delete('escaped'), 'Missing archive layout');
  const m = readJSON(path.join(dir,'manifest.json'));
  check(m.format === 1 && identity(m.source) === identity(row) && m.source.raw === row.raw &&
    m.session === session && m.partial === false && m.failed?.length === 0 &&
    Array.isArray(m.entries) && Array.isArray(m.directories) && m.files === m.entries.length,
    'Partial, malformed or mismatched manifest');
  const seen = new Set();
  function claim(full) {
    remoteParts(full);
    check(!seen.has(full), 'Duplicate manifest path ' + full);
    seen.add(full);
  }
  for (const d of m.directories) {
    claim(d.path);
    if (d.local !== null) check(d.local === 'data' + d.path && dirs.delete(d.local), 'Missing directory '+d.path);
  }
  let total = 0;
  for (const e of m.entries) {
    claim(e.path);
    check((e.local === 'data' + e.path || e.local === 'escaped/'+crypto.createHash('sha256').update(e.path).digest('hex')) &&
      files.delete(e.local), 'Missing or invalid file '+e.path);
    const target = path.join(dir,e.local);
    check((await fsp.stat(target)).size === e.size && await hashFile(target) === e.sha256, 'Size/hash mismatch '+e.path);
    total += e.size;
  }
  const logicalDirectories = new Set(m.directories.map(d => d.path));
  for (const full of seen) {
    const parent = full.slice(0,full.lastIndexOf('/'));
    if (parent) check(logicalDirectories.has(parent), 'Missing logical directory '+parent);
  }
  check(total === m.bytes && !files.size && !dirs.size, 'Totals or extra archive contents differ');
  return {files:m.files, bytes:total};
}

module.exports = {pullOne, verifyOne};
