import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {QmdWorkerClient} from '../../src/qmd-worker-client.ts';

const [root,scenario]=process.argv.slice(2);
const children:any[]=[];const callbacks=new Map<any,Function>();
const spawn=cp.spawn;
cp.spawn=((...args:any[])=>{const child=(spawn as any)(...args);children.push(child);const write=child.stdin.write;child.stdin.write=function(...values:any[]){const cb=values.at(-1);if(typeof cb==='function')callbacks.set(child,cb);return write.apply(this,values);};return child;}) as typeof cp.spawn;
syncBuiltinESMExports();
const worker=new QmdWorkerClient(2000,{idleExitMs:100});
const request={version:2 as const,sdkUrl:pathToFileURL(join(root,'synthetic-qmd/sdk.mjs')).href,dbPath:join(root,'index.sqlite'),config:{collections:{notes:{path:join(root,'notes')}}},operation:'status'};
try{
 await worker.request(request);const old=children[0];
 if(scenario.startsWith('idle-')||scenario==='cancel-write')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
 if(scenario==='idle-shutdown'){
  await worker.shutdown();assert.equal(worker.processId,undefined);
 }else if(scenario==='late-events'){
  const closed=new Promise(resolve=>old.once('close',resolve));old.stdin.emit('error',Object.assign(new Error('synthetic'),{code:'EPIPE'}));await closed;
  await writeFile(join(root,'behavior.json'),JSON.stringify({embedDelay:150}));
  const next=worker.request({...request,operation:'refresh',collections:['notes'],semantic:true},{progressive:true});
  old.emit('close',1,null);old.emit('error',new Error('late old child'));
  old.stdout.emit('data',Buffer.from('not json\n'));old.stdin.emit('error',new Error('late old stream'));
  callbacks.get(old)?.(new Error('late write callback'));
  await next;assert.equal(children.length,2);
 }else{
  if(scenario==='sync-write')old.stdin.write=()=>{throw Object.assign(new Error('synthetic'),{code:'EPIPE'});};
  const controller=new AbortController();const pending=worker.request(request,{signal:controller.signal});
  const rejected=assert.rejects(pending,{code:scenario==='cancel-write'?'CANCELLED':'BACKEND_FAILED'});
  if(scenario==='cancel-write')controller.abort();
  if(scenario==='stdout-error')old.stdout.emit('error',new Error('synthetic read failure'));
  if(scenario==='stderr-error')old.stderr.emit('error',new Error('synthetic read failure'));
  await rejected;
  assert.equal(worker.processId,undefined);assert.equal(children.length,1,'failed work is never replayed');
  await worker.request(request);assert.equal(children.length,2,'a later independent call may reopen');
 }
 console.log(JSON.stringify({scenario,hostSurvived:true,spawns:children.length}));
}finally{await worker.shutdown();}
