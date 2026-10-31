import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { createQmdFixture } from './fixtures/qmd-fixture.ts';
import { QmdWorkerClient } from '../src/qmd-worker-client.ts';
for(const scenario of ['idle-request','idle-shutdown','cancel-write','sync-write','late-events','stdout-error','stderr-error'])test(`transport errors stay inside the datastore: ${scenario}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'datastore-transport-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'notes'));await writeFile(join(root,'notes','one.md'),'Synthetic copper fixture.');await createQmdFixture(root);
 const output=execFileSync(process.execPath,[fileURLToPath(new URL('./fixtures/worker-transport-probe.ts',import.meta.url)),root,scenario],{encoding:'utf8',timeout:10000});
 assert.equal(JSON.parse(output).hostSurvived,true);
});

test('public store closes at idle exit and reopens durable state',async t=>{
 const root=await mkdtemp(join(tmpdir(),'datastore-worker-public-'));const sdk=await createQmdFixture(root);const notes=join(root,'notes');await mkdir(notes);await writeFile(join(notes,'one.md'),'copper');const worker=new QmdWorkerClient(2000,{idleExitMs:100});t.after(async()=>{await worker.shutdown();await rm(root,{recursive:true,force:true});});const request={version:2 as const,sdkUrl:pathToFileURL(join(sdk,'sdk.mjs')).href,dbPath:join(root,'index.sqlite'),config:{collections:{notes:{path:notes}}},operation:'refresh',collections:['notes'],semantic:false};await worker.request(request,{progressive:true});const id=worker.processId;await new Promise(r=>setTimeout(r,200));assert.equal(worker.processId,undefined);const result=await worker.request({...request,operation:'search',collection:'notes',query:'copper',mode:'lexical',limit:5});assert.equal(result.results.length,1);assert.notEqual(worker.processId,id);const log=await readFile(join(root,'calls.log'),'utf8');assert.equal(log.split('\n').filter(x=>x==='close').length,1);
});

test('native public store retains repeated-query behavior across idle exit and restart', {skip:process.env.DATASTORE_QMD_SEMANTIC_TEST!=='1',timeout:90000},async t=>{
 assert.ok(process.env.DATASTORE_QMD_PACKAGE);const pkg=process.env.DATASTORE_QMD_PACKAGE!;const metadata=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));assert.equal(metadata.version,'2.8.3');const root=await mkdtemp(join(tmpdir(),'datastore-native-worker-'));const notes=join(root,'notes');await mkdir(notes);await writeFile(join(notes,'one.md'),'# Marsh\nCopper heron visits a quiet wetland.\n');const worker=new QmdWorkerClient(60000,{idleExitMs:1000});t.after(async()=>{await worker.shutdown();await rm(root,{recursive:true,force:true});});const request={version:2 as const,sdkUrl:pathToFileURL(join(pkg,metadata.exports['.'].import)).href,dbPath:join(root,'index.sqlite'),config:{collections:{notes:{path:notes,pattern:'**/*.md',ignore:[],includeByDefault:false}}},operation:'refresh',collections:['notes'],semantic:true};const updated=await worker.request(request,{progressive:true});assert.equal(updated.embed.errors,0);const search={...request,operation:'search',collection:'notes',query:'copper heron wetland',mode:'hybrid',limit:5};const durations=[];for(let i=0;i<2;i++){const started=Date.now();assert.equal((await worker.request(search)).results.length,1);durations.push(Date.now()-started);}const pid=worker.processId;for(let i=0;i<100&&worker.processId;i++)await new Promise(r=>setTimeout(r,50));assert.equal(worker.processId,undefined);const started=Date.now();assert.equal((await worker.request(search)).results.length,1);durations.push(Date.now()-started);assert.notEqual(worker.processId,pid);t.diagnostic(JSON.stringify({coldRepeatReopenWallMs:durations}));
});

test('malformed public output and a stalled operation fail closed and reap their worker',async t=>{
 const root=await mkdtemp(join(tmpdir(),'datastore-worker-invalid-'));const sdk=join(root,'sdk.mjs');await writeFile(sdk,"export async function createStore(){return {getStatus:async()=>({totalDocuments:-1,needsEmbedding:0,hasVectorIndex:false}),getIndexHealth:async()=>({}),listCollections:async()=>[],close:async()=>{}}}");const worker=new QmdWorkerClient(100);t.after(async()=>{await worker.shutdown();await rm(root,{recursive:true,force:true});});const request={version:2 as const,sdkUrl:pathToFileURL(sdk).href,dbPath:join(root,'index.sqlite'),config:{collections:{}},operation:'status'};await assert.rejects(worker.request(request),{code:'BACKEND_OUTPUT_INVALID'});assert.equal(worker.processId,undefined);
 await writeFile(sdk,"export async function createStore(){return {getStatus:async()=>new Promise(()=>{}),close:async()=>{}}}");await assert.rejects(worker.request(request),{code:'TIMEOUT'});assert.equal(worker.processId,undefined);
});
