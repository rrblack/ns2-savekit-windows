'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
async function testFinish(host,temp) {
  const inject=path.join(temp,'simulated-runner.cjs');
  const run=path.join(host,'runs','switch2-finish');
  const lock=path.join(run,'backup-client.lock');
  await fs.writeFile(inject,`const fs=require('node:fs'),{EventEmitter}=require('node:events');
const runner=require(process.env.TEST_RUNNER);
runner.main=async(args)=>{
  const dir=process.env.TEST_RUN;
  fs.mkdirSync(dir);
  fs.writeFileSync(dir+'/result.json',JSON.stringify({verified:true,rpc:{state:'listening'}}));
  fs.writeFileSync(dir+'/backup-client.lock','fixture');
  const done=runner.waitForRpcStop({socket:new EventEmitter()});
  console.log('fixture-held');
  const reason=await done;
  if(reason!=='SIGINT') throw Error(reason);
  console.log('fixture-released');
};`);
  const proc=spawn(process.execPath,['--require',inject,path.join(host,'backup/host.cjs'),'127.0.0.1'],
    {env:{...process.env,TEST_RUNNER:path.join(host,'run.cjs'),TEST_RUN:run},timeout:15000,windowsHide:true});
  let stdout='',stderr='',sent=false,retried=false;
  proc.stderr.on('data',b=>stderr+=b);
  const done=new Promise((res,rej)=>{proc.on('error',rej);proc.on('close',res);});
  proc.stdout.on('data',b=>{
    stdout+=b;
    if (!sent && stdout.includes('fixture-held')) {sent=true;proc.stdin.write('finish\n');}
    if (!retried && stdout.includes('Finish deferred:')) {
      retried=true;require('node:fs').unlinkSync(lock);proc.stdin.write('finish\n');
    }
  });
  assert.equal(await done,0,stdout+'\n'+stderr);
  assert.ok(retried && stdout.includes('fixture-released'),stdout);
  await assert.rejects(fs.stat(lock),e=>e.code==='ENOENT');
  console.log('PASS finish waits for backup client and triggers the original parent release handler');
}
module.exports={testFinish};
