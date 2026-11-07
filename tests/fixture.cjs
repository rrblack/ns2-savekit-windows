'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const uid = '1032547698badcfe0132547698badcfe';
const acnh = '01006f8002326000';
const contents = Buffer.alloc(0x40003,0x71);
const nested = {'/':['dir','empty','manifest.json','CON','twin','TWIN'],
  '/dir':['island.bin'], '/empty':[]};
const files = {'/dir/island.bin':contents,'/manifest.json':Buffer.from('game manifest'),
  '/CON':Buffer.from('reserved'),'/twin':Buffer.from('a'),'/TWIN':Buffer.from('B')};
const definitions = [
  {id:21,app:acnh,type:3, tree:nested, files},
  {id:22,app:'0100000000000001',type:1,uid,tree:{'/':['normal.sav']},files:{'/normal.sav':Buffer.from('normal')}},
  {id:23,app:'0100000000000002',type:5,index:7,rank:1,tree:{'/':['cache']},files:{'/cache':Buffer.from([1])}},
  {id:24,app:'0100000000000003',type:1,uid,refusal:0xe02},
  {id:25,app:'0100000000000004',type:2,tree:{'/':['locked','denied','readable']},files:{'/locked':Buffer.from([3]),'/denied':Buffer.from([1]),'/readable':Buffer.from([7])},lockedFile:true},
  {id:27,app:'0100000000000003',type:1,tree:{'/':['common']},files:{'/common':Buffer.from('common uid')}},
  {id:26,app:'0000000000000000',space:0,type:0,static:'8123456789abcdef',tree:{'/':[]}},
];
function record(e) {
  const b=Buffer.alloc(0x60);
  b.writeBigUInt64LE(BigInt(e.id)); b[8]=e.space??1; b[9]=e.type;
  Buffer.from(e.uid || '00'.repeat(16),'hex').copy(b,16);
  b.writeBigUInt64LE(BigInt('0x'+(e.static||'0')),0x20); b.writeBigUInt64LE(BigInt('0x'+e.app),0x28);
  b.writeBigUInt64LE(1048576n,0x30); b.writeUInt16LE(e.index||0,0x38); b[0x3a]=e.rank||0;
  return b;
}
function makeNative(host) {
  const sdk = 0x1000000, base=0x2000000, scratch=0x2200000;
  const mem=Buffer.alloc(scratch+0x10000);
  const sdkFns=require(path.join(host,'engine/shared/sdk-functions.json'));
  const hashFn=require(path.join(host,'engine/switch2/app/hash-code.json'));
  for(const f of [...Object.values(sdkFns),hashFn])
    Buffer.from(f.bytes,'hex').copy(mem,sdk+f.offset);
  const handles=new Map();
  let serial=100, allocated=false;
  const add=h=>{handles.set(++serial,h); return serial;};
  const ops=[];
  const root=17;
  function dispatch(handle, b) {
    const w=b.readUInt32LE(), sfci=b.indexOf('SFCI');
    assert.ok(sfci>=16);
    const cmd=b.readUInt32LE(sfci+8), data=b.subarray(sfci+16);
    const output=Buffer.alloc(256);
    const flat=(value=0,result=0,child=0)=>{
      let header=16;
      if(child) {output.writeUInt32LE(0x80000008,4);output.writeUInt32LE(32,8);output.writeUInt32LE(child,12);}
      output.write('SFCO',header); output.writeUInt32LE(result,header+8); output.writeBigUInt64LE(BigInt(value),header+16);
      return output;
    };
    const object=handles.get(handle);
    ops.push([object?.kind || (handle===root?'root':'?'),cmd]);
    const mapAddress=()=>{assert.equal((w>>>24)&15,1); return b.readUInt32LE(12);};
    if(handle===root && cmd===61) {
      if(data[0]===2) return flat(0,0x137e02);
      return flat(0,0,add({kind:'reader',rows:definitions.filter(e=>(e.space??1)===data[0]),page:0}));
    }
    if(handle===root && cmd===53) {
      const found=definitions.find(e=>(e.space??1)===data[0] && e.type===data[40] &&
        (e.rank||0)===data[41] && (e.index||0)===data.readUInt16LE(42) &&
        data.readBigUInt64LE(8)===BigInt('0x'+e.app) && data.readBigUInt64LE(32)===BigInt('0x'+(e.static||'0')) &&
        data.subarray(16,32).toString('hex')===(e.uid||'00'.repeat(16)));
      if(!found || found.refusal) return flat(0,found?.refusal||0x7d402);
      return flat(0,0,add({kind:'archive',e:found}));
    }
    if(object?.kind==='reader' && cmd===0) {
      const rows=object.page++ ? [] : object.rows;
      Buffer.concat(rows.map(record)).copy(mem,mapAddress()); return flat(rows.length);
    }
    if(object?.kind==='acc' && cmd===140) return flat();
    if(object?.kind==='acc' && cmd===2) {
      assert.equal((b.readUInt32LE(4)>>>10)&15,3);
      assert.equal(b.readUInt16LE(40),128); assert.equal(b.readUInt16LE(50),128);
      Buffer.from(uid,'hex').copy(mem,b.readUInt32LE(44)); return flat();
    }
    if(object?.kind==='archive' && (cmd===8 || cmd===9)) {
      const addr=b.readUInt32LE(12), name=mem.toString('utf8',addr,mem.indexOf(0,addr));
      const e=object.e;
      if(cmd===9) {
        assert.equal(data.readUInt32LE(),3);
        assert.ok(e.tree[name]);
        return flat(0,0,add({kind:'dir',e,name,i:0}));
      }
      assert.equal(data.readUInt32LE(),1);
      if(e.lockedFile && name==='/locked') return flat(0,0x2ee02);
      assert.ok(e.files[name]); return flat(0,0,add({kind:'file',bytes:e.files[name],denied:e.lockedFile && name==='/denied'}));
    }
    if(object?.kind==='dir' && cmd===0) {
      const {e,name}=object, names=e.tree[name].slice(object.i,object.i+4); object.i+=names.length;
      const out=Buffer.alloc(names.length*0x310);
      names.forEach((n,i)=>{const rel=(name==='/'?'':name)+'/'+n;out.write(n,i*0x310);
        out[i*0x310+0x304]=e.tree[rel]?0:1;
        out.writeBigUInt64LE(BigInt(e.files?.[rel]?.length||0),i*0x310+0x308);});
      out.copy(mem,mapAddress()); return flat(names.length);
    }
    if(object?.kind==='file' && cmd===4) return flat(object.bytes.length);
    if(object?.kind==='file' && cmd===0) {
      if(object.denied) return flat(0,0x2ee02);
      const offset=Number(data.readBigUInt64LE(8)), n=Number(data.readBigUInt64LE(16));
      const bytes=object.bytes.subarray(offset,offset+n);
      bytes.copy(mem,mapAddress()); return flat(bytes.length);
    }
    throw Error('Unexpected service command '+handle+'/'+cmd);
  }
  const connection={error:null,fail(error){this.error=error;}};
  return {sdk,base,scratch,root,ops,handles,connection,output:base,calls:0,
    query(a) {return a<base ? {address:sdk,size:0x600000,permissions:5} :
      {address:a>=scratch?scratch:base, size:0x80000,type:5,permissions:3};},
    read(a,n){return mem.subarray(a,a+n);}, write(a,b){b.copy(mem,a);},
    async call(fn,...raw) {
      const [a,b,c,d]=raw.map(Number); this.calls++;
      let result=0n;
      if(fn===sdkFns.allocate.offset) {assert.equal(allocated,false);allocated=true;mem.writeBigUInt64LE(BigInt(base),a);}
      else if(fn===sdkFns.free.offset){assert.equal(a,base);allocated=false;}
      else if(fn===sdkFns.memset.offset) mem.fill(b,a,a+c);
      else if(fn===sdkFns.send.offset) dispatch(c,Buffer.from(mem.subarray(a,a+256))).copy(mem,a);
      else if(fn===sdkFns.getService.offset){assert.equal(mem.toString('utf8',b,b+c),'acc:u0');mem.writeUInt32LE(add({kind:'acc'}),a);}
      else if(fn===sdkFns.close.offset){assert.ok(handles.delete(a),'Closing unowned handle '+a);}
      else if(fn===hashFn.offset){assert.equal(b,32);crypto.createHash('sha256').update(mem.subarray(c,c+d)).digest().copy(mem,a);}
      else assert.equal(fn,0x5872f0,'unexpected SDK call');
      return {result,output:Buffer.alloc(0)};
    }};
}
module.exports={makeNative,record,definitions,acnh,uid,contents};
