'use strict';
// Front end to the unmodified Windows runner. Deliver the normal release signal only
// within its parent process, so terminal Ctrl+C never reaches its pipeline children.
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../run.cjs');
async function main(args) {
  if (args.length !== 1 || !require('node:net').isIPv4(args[0]))
    throw Error('Usage: node backup/host.cjs PC-ETHERNET-IP');
  const runs = path.join(__dirname,'..','runs');
  fs.mkdirSync(runs,{recursive:true});
  const existing = new Set(fs.readdirSync(runs));
  const input = readline.createInterface({input:process.stdin,terminal:false});
  let releaseLock;
  input.on('line', value => {
    if (value.trim().toLowerCase() !== 'finish') return;
    const fresh = fs.readdirSync(runs).filter(n => !existing.has(n) && n.startsWith('switch2-'));
    if (fresh.length !== 1) { console.log('Cannot identify a single new run for release.'); return; }
    const dir = path.join(runs,fresh[0]);
    try {
      const result = JSON.parse(fs.readFileSync(path.join(dir,'result.json')));
      if (result.rpc?.state !== 'listening' || !result.verified || !process.listenerCount('SIGINT'))
        throw Error('The held session is not ready for release');
      const lock = path.join(dir,'backup-client.lock');
      try { fs.closeSync(fs.openSync(lock,'wx')); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        let owner;
        try { owner = JSON.parse(fs.readFileSync(lock,'utf8')); } catch {}
        if (owner?.kind !== 'backup-client' || owner.session !== fresh[0] || !Number.isInteger(owner.pid) || owner.pid < 1)
          throw Error('A backup client or release still holds the run lock');
        try { process.kill(owner.pid, 0); } catch (probe) {
          if (probe.code !== 'ESRCH') throw probe;
          owner.exited = true;
        }
        if (!owner.exited) throw Error('A backup client still holds the run lock');
        console.log('Backup client exited before unlocking. Retaining the lock during guarded release.');
      }
      releaseLock = lock;
      console.log('Releasing the held endpoint. Keep SmileBASIC open until cleanup finishes.');
      process.emit('SIGINT'); // Invokes run.cjs waitForRpcStop, no OS signal or child kill.
    } catch (err) { console.log('Finish deferred:',err.message); }
  });
  console.log('When all backup commands have exited, type finish here and press Enter.');
  try { return await runner.main(['--rpc',args[0]]); }
  finally { input.close(); if (releaseLock) fs.unlinkSync(releaseLock); }
}
if (require.main === module) main(process.argv.slice(2)).catch(e => {console.error(e.message);process.exitCode=1;});
module.exports = {main};
