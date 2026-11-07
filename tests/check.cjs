'use strict';
// Isolated loopback fixture. Never selects a live run or binds the console port.
const fs=require('node:fs/promises'), path=require('node:path'), os=require('node:os'), net=require('node:net');
const assert=require('node:assert/strict'), {spawn}=require('node:child_process');
const {makeNative,definitions,record,uid,contents}=require('./fixture.cjs');
const [original, installed]=process.argv.slice(2).map(p=>path.resolve(p));
const json=async(p,x)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(x));};
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
async function cmd(args, expected=0) {
  const child=spawn(process.execPath,args,{stdio:['ignore','pipe','pipe'],windowsHide:true});
  let out='',err='';
  child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('exit',res);});
  assert.equal(code,expected,args[0]+' returned '+code+'\n'+out+'\n'+err);
  return out+'\n'+err;
}
async function wireTests(host) {
  const old=require(path.join(original,'engine/shared/ipc.cjs'));
  const next=require(path.join(host,'engine/shared/ipc.cjs'));
  let total=0;
  for(let size=0;size<=64;size++)for(const pid of [false,true])for(const sendN of [0,1,2])for(const recvN of [0,1]) {
    const opts={pid,copies:pid?[9,11]:[],send:Array.from({length:sendN},(_,i)=>({address:65536+i*4096,size:100+i})),
      receive:Array.from({length:recvN},(_,i)=>({address:131072+i*4096,size:50+i}))};
    assert.deepEqual(next.packet(7,Buffer.alloc(size,51),opts),old.packet(7,Buffer.alloc(size,51),opts));total++;
  }
  // Independent mixed X/A/B/C golden offsets with an odd CMIF data length.
  const wire=next.packet(17,Buffer.from([0xaa,0xbb,0xcc]),{copies:[8],pid:true,
    pointers:{send:[{address:0x123456789a,size:7}],receive:[{address:0x1012345678,size:0x80},
      {address:0x100000000,size:0x20,fixed:true}]},send:[{address:0x1000,size:10}],receive:[{address:0x2000,size:20}]});
  assert.equal(wire.readUInt32LE(0),0x01110004);
  assert.equal(wire.readUInt32LE(4),0x8000100a);
  assert.equal(wire.readUInt32LE(24),0x72040);assert.equal(wire.readUInt32LE(28),0x3456789a);
  assert.equal(wire.toString('ascii',64,68),'SFCI');assert.deepEqual(wire.subarray(80,83),Buffer.from([0xaa,0xbb,0xcc]));
  assert.equal(wire.readUInt16LE(92),0x80);assert.equal(wire.readUInt32LE(96),0x12345678);
  assert.equal(wire.readUInt32LE(100),0x00800010);assert.equal(wire.readUInt32LE(108),0x00200001);
  assert.throws(()=>next.packet(3,Buffer.alloc(256)),/capacity/);
  assert.throws(()=>next.receiveDescriptor({address:0,size:65536}));
  const ncm=require(path.join(host,'engine/switch2/ro/ncm.cjs'));
  const out=Buffer.alloc(16384),data=Buffer.alloc(8);data.writeInt32LE(1);data.writeInt32LE(1,4);out[12]=0x80;
  assert.equal(ncm.parse({result:0,data},out,0x80,0).keys[0].type,0x80);
  assert.throws(()=>ncm.parse({result:0,data},out),/type/);
  const cleanup=require(path.join(host,'engine/switch2/cleanup-scratch.cjs'));
  assert.throws(()=>cleanup.checkHostSave([{name:'NS2_GAP_notes'}],true));
  assert.throws(()=>cleanup.checkHostSave([{name:'main'}],true));
  cleanup.checkHostSave([{name:'TXT_NS2'}],true);
  console.log('PASS',total,'legacy packet comparisons, checked mixed descriptor bytes, NCM filters and host-save collision guards');
}
async function runFixture(temp) {
  const host=path.join(temp,'Windows Host'),session='switch2-offline',run=path.join(host,'runs',session);
  const snapshot=path.join(temp,'snapshot'), cli=path.join(host,'backup/cli.cjs');
  await fs.mkdir(host);
  for(const name of ['engine','run.cjs','rpc.cjs','bootstrap.bas','dump-firmware.cjs','backup'])
    await fs.cp(path.join(installed,name),path.join(host,name),{recursive:true});
  await wireTests(host);
  await fs.mkdir(run,{recursive:true});
  for(const name of ['shared','switch2']) await fs.cp(path.join(host,'engine',name),path.join(run,name),{recursive:true});
  const native=makeNative(host), {serve}=require(path.join(host,'engine/lib/bridge.cjs'));
  const bridge=await serve(native);
  let socketPath=process.platform==='win32' ? '\\\\.\\pipe\\ns2-offline-'+process.pid :
    0;
  let activeSession=session;
  const server=net.createServer(socket=>{
    socket.on('error',()=>{});
    let msg='';socket.on('data',part=>{msg+=part;if(msg.includes('\n')) {
      assert.deepEqual(JSON.parse(msg),{command:'root-native-info'});
      socket.end(JSON.stringify({session:activeSession,worker:{joined:true}})+'\n');
    }});
  });
  try {
    await new Promise((res,rej)=>{server.once('error',rej);server.listen(socketPath || {port:0,host:'127.0.0.1'},res);});
    if (!socketPath) socketPath=server.address().port;
    const sourceSha256=await require(path.join(host,'run.cjs')).sourceDigest();
    await json(path.join(run,'connection.json'),{port:bridge.port,addresses:{session,platform:2,sdk:native.sdk,scratch:native.scratch}});
    await json(path.join(run,'result.json'),{sourceSha256,verified:true,rpc:{mode:'held',state:'listening'}});
    await json(path.join(run,'switch2/current-acquisition.json'),{session,socketPath});
    const rootPath=path.join(run,'switch2/ro/root/current-root.json');
    await json(rootPath,{session,pid:1,rootHandle:native.root});
    await json(path.join(run,'switch2/fs-execution-current.json'),{session,verified:true,restored:true,cleanup:{deferred:true},
      retainedEndpoint:{session,ready:true,socketPath}});
    // Exercise real mount inspection (module requires the copied connection and snapshot).
    const app=path.join(run,'switch2/app');
    await json(path.join(app,'mounts.json'),{session,mounts:[{name:'save',accessor:11,implementation:22,service:33,serviceVtable:44}]});
    const layout=require(path.join(run,'shared/sdk-layout.json')), memory=new Map();
    for(const v of layout.verifiedFunctions) memory.set(native.sdk+v.offset,Buffer.from(v.bytes,'hex'));
    const accessor=Buffer.alloc(48);accessor.write('save',24);accessor.writeBigUInt64LE(22n,40);memory.set(11,accessor);
    const impl=Buffer.alloc(24);impl.writeBigUInt64LE(33n,16);memory.set(22,impl);
    const service=Buffer.alloc(32);service.writeBigUInt64LE(44n);service.writeBigUInt64LE(55n,16);service.writeUInt32LE(3,24);memory.set(33,service);
    const manager=Buffer.alloc(0x80);manager.writeUInt32LE(0x800,8);manager.writeBigUInt64LE(66n,16);manager.writeUInt32LE(3,0x5c);
    memory.set(55,manager);memory.set(66,Buffer.from([77,0,0,0]));
    const {inspectMountedFilesystem}=require(path.join(app,'mounted-save.cjs'));
    const io={read:async(a,n)=>{const b=memory.get(a);assert.equal(b.length,n);return b;}};
    const mount=await inspectMountedFilesystem(io,'tmp');
    assert.equal(mount.name,'save');assert.equal(mount.borrowed,77);assert.equal(mount.serviceAddress,33);
    manager[8]++; await assert.rejects(inspectMountedFilesystem(io,'tmp'),/manager/);manager[8]--;
    console.log('PASS save-only mount inspection, borrow validation and missing-tmp fallback');
    const stock=path.join(__dirname,'upstream/tools');
    const accounts=await cmd([path.join(stock,'save-pull-root.cjs'),run,'0','.', '--list-uids']);
    assert.match(accounts,new RegExp(uid));
    const stockInventory=path.join(temp,'stock.json');
    await cmd([path.join(stock,'save-inventory.cjs'),run,'--space','1','--json',stockInventory]);
    assert.equal((await read(stockInventory)).entries.find(e=>e.type===5).index,0);
    const stockOut=path.join(temp,'stock output');
    await cmd([path.join(stock,'pull-inventory.cjs'),run,stockOut,'--inventory',stockInventory,'--only','22']);
    assert.equal((await read(path.join(stockOut,'inventory-progress.json'))).done.length,1);
    await cmd([path.join(stock,'pull-inventory.cjs'),run,stockOut,'--inventory',stockInventory,'--only','24']);
    const oldWrong=(await fs.readdir(stockOut)).find(name=>name.endsWith('-id24'));
    assert.equal((await read(path.join(stockOut,oldWrong,'manifest.json'))).uid,'00'.repeat(16));
    assert.ok((await read(path.join(stockOut,'inventory-progress.json'))).done.some(k=>k.endsWith(':24')));
    console.log('REPRODUCED upstream wrong-UID fallback recorded as success for the locked account');
    console.log('PASS pinned savekit CLI account enumeration, FS inventory, bulk pull and actual pull child');
    await cmd([cli,'inventory',run,snapshot]);
    const inv=await read(path.join(snapshot,'inventory.json'));
    assert.equal(inv.entries.length,definitions.length);assert.equal(inv.entries.find(e=>e.id==='23').index,7);
    assert.equal(inv.spaces[2].error,'0x137e02');
    const stockCount=native.ops.length;
    await cmd([cli,'export',run,snapshot],2);
    const report=await read(path.join(snapshot,'verification.json'));
    assert.equal(report.verified,5);assert.equal(report.rows.find(e=>e.id==='24').error,'0xe02');
    const partial=report.rows.find(e=>e.id==='25');
    assert.equal(partial.state,'partial');assert.equal(partial.failed.length,2);
    assert.deepEqual(await fs.readFile(path.join(snapshot,partial.stage,'data/readable')),Buffer.from([7]));
    assert.equal(report.rows.find(e=>e.id==='26').state,'verified-empty');
    const island=path.join(snapshot,'space-1-id-21');
    assert.deepEqual(await fs.readFile(path.join(island,'data/dir/island.bin')),contents);
    const m=await read(path.join(island,'manifest.json'));
    assert.ok(m.entries.find(f=>f.path==='/CON').local.startsWith('escaped/'));
    assert.equal(m.entries.filter(f=>['/TWIN','/twin'].includes(f.path)).length,2);
    assert.equal(native.ops.slice(stockCount).filter(([obj,id])=>obj==='root' && id===53).length,definitions.length);
    const n=native.ops.length;await cmd([cli,'export',run,snapshot],2);assert.equal(native.ops.length,n);
    await fs.writeFile(path.join(island,'data/dir/island.bin'),Buffer.from('tampered'));
    await cmd([cli,'verify',snapshot],2);assert.equal((await read(path.join(snapshot,'verification.json'))).verified,4);
    await fs.writeFile(path.join(island,'data/dir/island.bin'),contents);
    const empty=path.join(snapshot,'space-0-id-26/data/stray');
    await fs.writeFile(empty,'unexpected');
    await cmd([cli,'verify',snapshot],2);assert.equal((await read(path.join(snapshot,'verification.json'))).verified,4);
    await fs.unlink(empty);
    const nextSession='switch2-nextboot', next=path.join(host,'runs',nextSession);
    await fs.cp(run,next,{recursive:true});
    for (const file of ['connection.json','switch2/current-acquisition.json','switch2/ro/root/current-root.json','switch2/fs-execution-current.json']) {
      const f=path.join(next,file);
      const meta=await read(f);
      if (meta.addresses) meta.addresses.session=nextSession; else meta.session=nextSession;
      if(meta.retainedEndpoint) meta.retainedEndpoint.session=nextSession;
      await json(f,meta);
    }
    activeSession=nextSession;
    const later=path.join(temp,'second snapshot');
    await cmd([cli,'inventory',next,later]);
    const opIndex=native.ops.length;
    await cmd([cli,'export',next,later,'--carry-from',snapshot],2);
    const laterReport=await read(path.join(later,'verification.json'));
    assert.equal(laterReport.verified,5);
    assert.equal(laterReport.rows.find(e=>e.id==='21').sourceSession,session);
    assert.equal(native.ops.slice(opIndex).filter(([obj,id])=>obj==='root' && id===53).length,2);
    activeSession=session;
    await json(rootPath,{session:'old',pid:1,rootHandle:native.root});await cmd([cli,'inventory',run,path.join(temp,'stale')],1);
    assert.equal(native.handles.size,0);
    await require('./finish.cjs').testFinish(host,temp);
    // A transport failure must send no cleanup/native follow-up on the uncertain connection.
    await json(rootPath,{session,pid:1,rootHandle:native.root});
    const call=native.call.bind(native), send=require(path.join(host,'engine/shared/sdk-functions.json')).send.offset;
    let tripped=false, afterFailure=0;
    native.call=async (fn,...args)=>{
      if(tripped) afterFailure++;
      if(fn===send && !tripped) {tripped=true;return {result:0xf601n,output:Buffer.alloc(0)};}
      return call(fn,...args);
    };
    await cmd([cli,'inventory',run,path.join(temp,'broken')],1);
    assert.ok(tripped);assert.equal(afterFailure,0);
    assert.match(await fs.readFile(path.join(run,'backup-stop.txt'),'utf8'),/transport/);
    await cmd([cli,'inventory',run,path.join(temp,'blocked')],1);
    assert.equal(afterFailure,0);

    console.log('PASS exact opens, static ID, indexed cache, shared multi-chunk save, Windows name mapping, empty/partial/locked states, no reopen, tampering, cross-session carry-forward, stale run');
  } finally {
    await bridge.close();
    if(server.listening) await new Promise(res=>server.close(res));
  }
}
(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'ns2-backup-test-'));
  try { await runFixture(temp); } finally {await fs.rm(temp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
