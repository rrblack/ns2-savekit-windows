'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const check = (ok, message) => { if (!ok) throw Error(message); };
const spaces = [1, 4, 0, 2, 3, 100, 101, 102];
const hexResult = n => '0x' + (n & 0x3fffff).toString(16);
const fields = ['space', 'type', 'uid', 'applicationId', 'staticId', 'rank', 'index'];
const attributeKey = e => JSON.stringify(fields.map(field => e[field]));
const identity = e => JSON.stringify([e.id, ...fields.map(field => e[field])]);
const folder = e => 'space-' + e.space + '-id-' + e.id;

function parseEntry(bytes, space) {
  check(bytes.length === 0x60 && bytes[8] === space, 'Mismatched SaveDataInfo size or space');
  const hex64 = at => '0x' + bytes.readBigUInt64LE(at).toString(16).padStart(16, '0');
  return {id: bytes.readBigUInt64LE(0).toString(), space, type: bytes[9],
    uid: bytes.subarray(0x10, 0x20).toString('hex'), staticId: hex64(0x20),
    applicationId: hex64(0x28), size: bytes.readBigUInt64LE(0x30).toString(),
    index: bytes.readUInt16LE(0x38), rank: bytes[0x3a], raw: bytes.toString('hex')};
}

// Uses the same service and record pagination as ns2-savekit's save-inventory.cjs.
// Only an explicit service refusal is a per-space outcome. Transport faults stop the run.
async function scanSpace(s, root, oneHandle, space) {
  const open = await s.ipc('OpenSaveDataInfoReader', root, 61, Buffer.from([space]));
  if (open.result) return {space, error: hexResult(open.result), entries: []};
  const reader = oneHandle(open);
  const entries = [];
  try {
    const slots = 64, address = s.base + 0x8000;
    for (let page = 0; page <= 64; page++) {
      await s.write(address, Buffer.alloc(slots * 0x60));
      const reply = await s.ipc('ReadSaveDataInfo', reader, 0, Buffer.alloc(0),
        {receive: [{address, size: slots * 0x60}]});
      if (reply.result) return {space, entries, error: 'read ' + hexResult(reply.result)};
      const count = Number(reply.data.readBigInt64LE());
      check(Number.isInteger(count) && count >= 0 && count <= slots, 'Invalid inventory page length');
      if (!count) return {space, entries, error: null};
      if (entries.length + count > 4096) return {space, entries, error: 'Inventory exceeded 4096 rows'};
      const bytes = await s.readOwned(address, count * 0x60);
      for (let i = 0; i < count; i++) entries.push(parseEntry(bytes.subarray(i*0x60, (i+1)*0x60), space));
    }
    return {space, entries, error: 'Inventory page limit reached without end-of-list'};
  } finally { await s.close(reader); }
}

async function openLive(run) {
  const host = path.resolve(__dirname, '..'), rt = path.join(run, 'switch2');
  check(path.dirname(run) === path.join(host, 'runs'), 'Use the exact run folder printed by this installed host');
  const result = readJSON(path.join(run, 'result.json'));
  const fsProof = readJSON(path.join(rt, 'fs-execution-current.json'));
  const acq = readJSON(path.join(rt, 'current-acquisition.json'));
  const root = readJSON(path.join(rt, 'ro/root/current-root.json'));
  const link = readJSON(path.join(run, 'connection.json'));
  const session = path.basename(run);
  check(result.verified && result.rpc?.mode === 'held' && result.rpc.state === 'listening' &&
    fsProof.verified && fsProof.restored && fsProof.cleanup?.deferred && fsProof.retainedEndpoint?.ready &&
    [fsProof.session, fsProof.retainedEndpoint.session, root.session, acq.session, link.addresses.session]
      .every(id => id === session) && root.pid === 1 && Number.isInteger(root.rootHandle) && root.rootHandle > 0 &&
    link.addresses.platform === 2 && acq.socketPath && acq.socketPath === fsProof.retainedEndpoint.socketPath,
    'Run is not the matching held, restored Switch 2 session with the promoted root');
  check(result.sourceSha256 === await require(path.join(host, 'run.cjs')).sourceDigest(),
    'Run was started from a different engine build');
  // The host copies these directories at pairing. A stale run can contain different code.
  for (const [name, digest] of Object.entries(readJSON(path.join(__dirname, 'runtime.json')))) {
    const file = path.join(run, name);
    check(createHash('sha256').update(fs.readFileSync(file)).digest('hex') === digest, 'Run module changed: ' + name);
  }
  const status = await require(path.join(host, 'rpc.cjs')).request(run, {command: 'status'});
  check(status.ready, 'Application bridge unavailable: ' + (status.error || 'closed'));
  const {request} = require(path.join(rt, 'tools/endpoint.cjs'));
  const native = await request(acq.socketPath, {command: 'root-native-info'}, 60000);
  check(native.session === session && native.worker?.joined, 'Retained endpoint does not match this idle session');
  const {Session} = require(path.join(rt, 'app/session.cjs'));
  const {oneHandle} = require(path.join(rt, 'app/domain.cjs'));
  const filesystem = require(path.join(rt, 'app/filesystem.cjs'));
  const s = new Session('backup-' + Date.now(), 0x80000);
  return {s, oneHandle, filesystem, root: root.rootHandle, session, sourceSha256: result.sourceSha256};
}

async function useLive(run, fn) {
  check(!fs.existsSync(path.join(run, 'backup-stop.txt')), 'This run recorded an uncertain transport/cleanup. Stop the host and retain its logs.');
  const name = path.join(run, 'backup-client.lock');
  const lock = fs.openSync(name, 'wx');
  try {
    fs.writeFileSync(lock, JSON.stringify({kind:'backup-client', pid:process.pid, session:path.basename(run)}));
    const live = await openLive(run), s = live.s;
    // Block a second operation on an uncertain session, including close/cleanup after an IPC timeout.
    // A known service refusal is a normal reply and does not trip this guard.
    let uncertain;
    for (const method of ['read', 'readOwned', 'write', 'call']) {
      const original = s[method].bind(s);
      s[method] = async (...args) => {
        if (uncertain) throw uncertain;
        try {
          const value = await original(...args);
          if (method === 'call' && ['send','close'].includes(args[0]) && value)
            throw Error(args[0] + ' transport ' + hexResult(value));
          return value;
        } catch (err) { uncertain = err; throw err; }
      };
    }
    try {
      await s.initialize();
      const call4 = s.rpc.call4;
      s.rpc.call4 = async (...args) => {
        try { return await call4(...args); } catch (err) { uncertain = err; throw err; }
      };
      return await fn(live);
    } finally {
      if (uncertain) {
        fs.writeFileSync(path.join(run, 'backup-stop.txt'), String(uncertain) + '\n', {flag:'a'});
      } else {
        try {
          await s.cleanup();
          check(!s.base && !s.handles.size, 'Application client cleanup was deferred');
        } catch (err) {
          fs.writeFileSync(path.join(run, 'backup-stop.txt'), String(err) + '\n', {flag:'a'});
          throw err;
        }
      }
    }
  } finally { fs.closeSync(lock); fs.unlinkSync(name); }
}

module.exports = {readJSON, check, spaces, hexResult, folder, attributeKey, identity, parseEntry, scanSpace, useLive};
