import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadMarkdownDatastoreConfig } from '../src/config.ts';
import { discoverQmdBinding, QmdAdapter, decodeQmdUri } from '../src/qmd-adapter.ts';
import { MarkdownDatastoreService } from '../src/service.ts';
import { createQmdFixture } from './fixtures/qmd-fixture.ts';
import { datastoreChildEnvironment } from '../src/child-environment.ts';
export async function fixture(t:any, real=false) {
 const project=await realpath(await mkdtemp(join(tmpdir(),'datastore-public-')));const notes=join(project,'notes');const dir=join(project,'.pi','markdown-datastore');await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);await mkdir(notes);
 await writeFile(join(notes,'alpha.md'),'# Alpha\n\nCopper heron crosses the marsh.\r\n');
 const packageRoot=real?process.env.DATASTORE_QMD_PACKAGE!:await createQmdFixture(project);
 const configPath=join(dir,'config.json');await writeFile(configPath,JSON.stringify({schemaVersion:1,defaults:{maxResultBytes:8192,maxResultLines:100,operationTimeoutMs:3000},qmd:{enabled:true,installation:{packageRoot},minimumVersion:'2.8.3'},stores:{memory:{root:'notes',include:['**/*.md'],exclude:[],maxFileBytes:4096,search:{defaultMode:'lexical',qmdCollection:'memory'}}}}),{mode:0o600});
 const config=await loadMarkdownDatastoreConfig(project,configPath);const adapter=new QmdAdapter(config,await discoverQmdBinding(config));const service=new MarkdownDatastoreService(config,undefined,adapter);t.after(async()=>{await service.shutdown();await rm(project,{recursive:true,force:true});});return {project,notes,config,adapter,service,store:config.stores.get('memory')!};
}
async function waitJob(adapter:QmdAdapter,id:string) {for(let i=0;i<1000;i++){const j=adapter.activity().jobs.find(j=>j.refreshId===id);if(j&&['succeeded','failed','cancelled'].includes(j.state))return j;await new Promise(r=>setTimeout(r,10));}throw new Error('job timeout');}
async function ready(f:Awaited<ReturnType<typeof fixture>>,semantic=false){const r=semantic?await f.adapter.startSemanticRefresh([f.store]):await f.adapter.startLexicalRefresh([f.store]);const j=await waitJob(f.adapter,String(r.refreshId));assert.equal(j.state,'succeeded',JSON.stringify(j));}
async function behavior(f:Awaited<ReturnType<typeof fixture>>,value:unknown){await mkdir(f.adapter.root,{recursive:true,mode:0o700});await writeFile(join(f.adapter.root,'behavior.json'),JSON.stringify(value),{mode:0o600});}

test('public URI identity is literal and collection-qualified',()=>{assert.equal(decodeQmdUri('qmd://notes/100%25.md','notes'),'100%25.md');for(const uri of ['qmd://other/a.md','qmd://notes/../a.md','#abcdef'])assert.throws(()=>decodeQmdUri(uri,'notes'));});
test('child environment passes supported local runtime controls without credentials',()=>{assert.deepEqual(datastoreChildEnvironment({HOME:'/tmp/home',QMD_EMBED_MODEL:'/tmp/model.gguf',XDG_CACHE_HOME:'/tmp/cache',QMD_FORCE_CPU:'1',OPENAI_API_KEY:'secret',NODE_OPTIONS:'bad',QMD_CONFIG_DIR:'/global'}),{HOME:'/tmp/home',PATH:'/usr/bin:/bin:/usr/sbin:/sbin',QMD_EMBED_MODEL:'/tmp/model.gguf',XDG_CACHE_HOME:'/tmp/cache',QMD_FORCE_CPU:'1'});});

test('durable public store supports exact paths, current body validation and repeated queries',async t=>{
 const f=await fixture(t);const paths=['Case Name.md','case-name.md','100%25.md','café.md','punctuation!.md','2026-10-13.md'];for(const p of paths)await writeFile(join(f.notes,p),'# Fixture\nCopper heron\n');await ready(f);
 const first=await f.service.search({store:'memory',query:'copper',mode:'lexical',limit:20,includeContent:true});assert.equal(first.data.returned,7);assert.equal(first.data.effectiveMode,'lexical');assert.ok(first.data.hits.every(h=>h.sourceRevision===h.indexedRevision));
 const again=await f.service.search({store:'memory',query:'copper',mode:'lexical',limit:20});assert.equal(first.data.workerId,again.data.workerId);
 assert.equal((await readFile(join(f.adapter.root,'calls.log'),'utf8')).split('\n').filter(v=>v==='open').length,2);
 await writeFile(join(f.notes,'alpha.md'),'# Changed\nNo match\n');const changed=await f.service.search({store:'memory',query:'copper',mode:'lexical',limit:20});assert.equal(changed.data.dropped,1);await assert.rejects(f.service.search({store:'memory',query:'copper',freshness:'require-current-lexical'}),{code:'STALE_INDEX'});
 await rename(join(f.notes,'case-name.md'),join(f.notes,'renamed.md'));await rm(join(f.notes,'100%25.md'));await ready(f);const updated=await f.service.search({store:'memory',query:'copper',limit:20});assert.ok(updated.data.hits.some(h=>h.path==='renamed.md'));assert.ok(updated.data.hits.every(h=>h.path!=='case-name.md'&&h.path!=='100%25.md'));
});

test('embedding admission serves independent lexical fallback and prompt retryable semantic error',async t=>{
 const f=await fixture(t);await ready(f);await behavior(f,{embedDelay:600});const receipt=await f.adapter.startSemanticRefresh([f.store]);
 while(!f.adapter.activity().active)await new Promise(r=>setTimeout(r,1));
 const before=Date.now();await assert.rejects(f.service.search({store:'memory',query:'copper',mode:'semantic'}),(e:any)=>e.code==='SEMANTIC_UNAVAILABLE'&&e.details.retryable&&/try again later/.test(e.message));assert.ok(Date.now()-before<200);
 const result=await f.service.search({store:'memory',query:'copper',mode:'hybrid'});assert.equal(result.data.requestedMode,'hybrid');assert.equal(result.data.effectiveMode,'lexical');assert.equal(result.data.hits[0].mode,'lexical');assert.ok(result.warnings.some(w=>w.code==='SEMANTIC_UNAVAILABLE'));assert.equal(f.adapter.activity().active,true);
 await assert.rejects(f.service.search({store:'memory',query:'copper',mode:'hybrid',freshness:'require-current-semantic'}),{code:'STALE_INDEX'});
 assert.equal((await waitJob(f.adapter,String(receipt.refreshId))).state,'succeeded');assert.equal(f.adapter.activity().active,false);
 const semantic=await f.service.search({store:'memory',query:'copper',mode:'semantic'});assert.equal(semantic.data.effectiveMode,'semantic');
});

test('failed and partial embedding report failure; cancellation clears active state after termination',async t=>{
 const f=await fixture(t);await ready(f);
 for(const settings of [{partial:true},{embedError:true},{updateError:true}]){await behavior(f,settings);const r=await f.adapter.startSemanticRefresh([f.store]);assert.equal((await waitJob(f.adapter,String(r.refreshId))).state,'failed');assert.equal(f.adapter.activity().active,false);assert.equal(f.adapter.isLexicallyCurrent('memory'),false);}
 await behavior(f,{embedDelay:10000});const r=await f.adapter.startSemanticRefresh([f.store]);while(!f.adapter.activity().active)await new Promise(r=>setTimeout(r,1));await f.adapter.cancelRefresh(String(r.refreshId));assert.equal((await waitJob(f.adapter,String(r.refreshId))).state,'cancelled');assert.equal(f.adapter.activity().active,false);await behavior(f,{});await ready(f,true);
});

test('search cancellation kills only owned reader and permits reopen',async t=>{
 const f=await fixture(t);await ready(f);await behavior(f,{searchDelay:10000});const controller=new AbortController();const result=f.service.search({store:'memory',query:'copper'},controller.signal);setTimeout(()=>controller.abort(),100);await assert.rejects(result,{code:'CANCELLED'});await behavior(f,{});assert.equal((await f.service.search({store:'memory',query:'copper'})).data.returned,1);
});

test('explicit refreshes reconcile concurrent changes; missing and symlink candidates are dropped',async t=>{
 const f=await fixture(t);await ready(f);await rm(join(f.notes,'alpha.md'));await symlink('/etc/hosts',join(f.notes,'alpha.md'));const r=await f.service.search({store:'memory',query:'copper'});assert.equal(r.data.returned,0);assert.equal(r.data.dropped,1);await rm(join(f.notes,'alpha.md'));await writeFile(join(f.notes,'new.md'),'copper');await ready(f);assert.equal((await f.service.search({store:'memory',query:'copper'})).data.hits[0].path,'new.md');
});

test('native qmd 2.8.3 package lexical and indexed-body contract', {skip:!process.env.DATASTORE_QMD_PACKAGE},async t=>{
 const f=await fixture(t,true);for(const p of ['Case Name.md','case-name.md','100%25.md','café.md','punctuation!.md','2026-10-13.md'])await writeFile(join(f.notes,p),'# Fixture\nCopper heron\r\n');await ready(f);const result=await f.service.search({store:'memory',query:'copper',limit:20});assert.equal(result.data.returned,7);assert.equal(result.data.dropped,0);assert.equal((await f.service.search({store:'memory',query:'copper',limit:20})).data.workerId,result.data.workerId);
});

test('recovery requeues interrupted jobs and requires fresh reconciliation',async t=>{
 const f=await fixture(t);await ready(f);await behavior(f,{embedDelay:10000});const receipt=await f.adapter.startSemanticRefresh([f.store]);while(!f.adapter.activity().active)await new Promise(r=>setTimeout(r,1));await f.adapter.shutdown();await behavior(f,{});
 const reopened=new QmdAdapter(f.config,await discoverQmdBinding(f.config));try {assert.equal(reopened.isLexicallyCurrent('memory'),false);await reopened.startupReconcile([f.store]);const recovered=await waitJob(reopened,String(receipt.refreshId));assert.equal(recovered.state,'succeeded',JSON.stringify(recovered));} finally {await reopened.shutdown();}
});

test('corrupt derived data is quarantined as a closed directory and rebuilt from source',async t=>{
 const f=await fixture(t);await ready(f);await f.adapter.shutdown();await writeFile(join(f.adapter.root,'backend','index.sqlite'),'invalid',{mode:0o600});const a=new QmdAdapter(f.config,await discoverQmdBinding(f.config));t.after(()=>a.shutdown());let receipt=await a.startLexicalRefresh([f.store]);assert.equal((await waitJob(a,String(receipt.refreshId))).state,'failed');receipt=await a.startLexicalRefresh([f.store]);assert.equal((await waitJob(a,String(receipt.refreshId))).state,'succeeded');assert.equal((await a.search(f.store,'copper','lexical',5,undefined)).candidates.length,1);
});

test('maintenance waits for admitted semantic reads; new requests cannot cross admission gate',async t=>{
 const f=await fixture(t);await ready(f,true);await behavior(f,{searchDelay:200,embedDelay:500});const first=f.service.search({store:'memory',query:'copper',mode:'semantic'});await new Promise(r=>setTimeout(r,30));const receipt=await f.adapter.startSemanticRefresh([f.store]);while(!f.adapter.activity().active)await new Promise(r=>setTimeout(r,1));await assert.rejects(f.service.search({store:'memory',query:'copper',mode:'semantic'}),{code:'SEMANTIC_UNAVAILABLE'});assert.equal((await first).data.effectiveMode,'semantic');assert.equal((await waitJob(f.adapter,String(receipt.refreshId))).state,'succeeded');
});

test('qualified native embedding, independent lexical reads and repeated hybrid searches', {skip:process.env.DATASTORE_QMD_SEMANTIC_TEST!=='1',timeout:180000},async t=>{
 assert.ok(process.env.DATASTORE_QMD_PACKAGE);const f=await fixture(t,true);f.config.defaults.operationTimeoutMs=60000;
 // Construct with the larger search deadline before loading any models.
 await f.adapter.shutdown();const a=new QmdAdapter(f.config,await discoverQmdBinding(f.config));const service=new MarkdownDatastoreService(f.config,undefined,a);t.after(()=>service.shutdown());
 for(let i=0;i<30;i++)await writeFile(join(f.notes,`native-${i}.md`),`# Marsh ${i}\nCopper heron visits wetland number ${i}.\n`);
 await a.refresh([f.store],false);const receipt=await a.startSemanticRefresh([f.store]);let reads=0;
 while(!a.activity().active)await new Promise(r=>setTimeout(r,1));
 while(a.activity().active){const r=await service.search({store:'memory',query:'copper',mode:'hybrid'});if(r.data.effectiveMode==='lexical'){reads++;assert.ok(r.warnings.some(w=>w.code==='SEMANTIC_UNAVAILABLE'));}await new Promise(r=>setTimeout(r,10));}
 assert.ok(reads>0);assert.equal((await waitJob(a,String(receipt.refreshId))).state,'succeeded');
 const semantic=await service.search({store:'memory',query:'bird in a wetland',mode:'semantic'});assert.ok(semantic.data.returned>0);assert.equal(semantic.data.effectiveMode,'semantic');const status=await a.status();assert.equal(status.state,'ready');assert.equal(status.pendingEmbeddings,0);
 const times=[];for(const query of ['copper heron wetland','copper heron wetland','birds visiting a marsh']){const start=Date.now();const r=await service.search({store:'memory',query,mode:'hybrid'});times.push(Date.now()-start);assert.ok(r.data.returned>0);assert.equal(r.data.effectiveMode,'hybrid');}
 await writeFile(join(f.notes,'cache-refresh.md'),'# Refreshed\nCopper heron wetland update.\n');await a.refresh([f.store],true);const afterUpdate=[];for(let i=0;i<2;i++){const start=Date.now();assert.ok((await service.search({store:'memory',query:'copper heron wetland',mode:'hybrid'})).data.returned>0);afterUpdate.push(Date.now()-start);}const controller=new AbortController();const cancelled=service.search({store:'memory',query:'previously unseen migratory nesting conditions',mode:'hybrid'},controller.signal);setTimeout(()=>controller.abort(),100);await assert.rejects(cancelled,{code:'CANCELLED'});assert.ok((await service.search({store:'memory',query:'copper',mode:'lexical'})).data.returned>0);t.diagnostic(JSON.stringify({lexicalReadsDuringEmbedding:reads,hybridWallMs:times,afterUpdateHybridWallMs:afterUpdate}));
});

test('binding rejects package upgrades and backend paths outside the configured collection',async t=>{
 const f=await fixture(t);const packagePath=join(f.config.qmd.installation.packageRoot!,'package.json');const pkg=JSON.parse(await readFile(packagePath,'utf8'));pkg.version='2.8.4';await writeFile(packagePath,JSON.stringify(pkg));await assert.rejects(discoverQmdBinding(f.config),{code:'BACKEND_VERSION_UNSUPPORTED'});await assert.rejects(f.adapter.startLexicalRefresh([f.store]),{code:'BACKEND_VERSION_UNSUPPORTED'});
});

test('zero-work timer ticks do not invoke update and clean lexical refresh does not embed',async t=>{
 const f=await fixture(t);await ready(f,true);const before=await readFile(join(f.adapter.root,'calls.log'),'utf8');t.mock.timers.enable({apis:['setTimeout']});t.mock.timers.tick(300000);await new Promise(r=>setImmediate(r));assert.equal(await readFile(join(f.adapter.root,'calls.log'),'utf8'),before);t.mock.timers.reset();await ready(f);const log=await readFile(join(f.adapter.root,'calls.log'),'utf8');assert.equal(log.split('\n').filter(x=>x==='embed').length,1);
});

test('queued explicit refresh is not considered current when an earlier refresh finishes',async t=>{
 const f=await fixture(t);await ready(f);await behavior(f,{updateDelay:100,embedDelay:200});const first=await f.adapter.startSemanticRefresh([f.store]);const second=await f.adapter.startLexicalRefresh([f.store]);await writeFile(join(f.notes,'new.md'),'Copper new publication');await waitJob(f.adapter,String(first.refreshId));if(f.adapter.activity().active)assert.equal(f.adapter.isLexicallyCurrent('memory'),false);assert.equal((await waitJob(f.adapter,String(second.refreshId))).state,'succeeded');assert.ok((await f.service.search({store:'memory',query:'copper',freshness:'require-current-lexical'})).data.hits.some(h=>h.path==='new.md'));
});

test("search snippets exclude frontmatter while preserving body fallback and budgets", async (t) => {
	const longMetadata = `---\nmessageId: 55\nprovenance: ${"x".repeat(1600)}\n---\n\n`;
	const cases = [
		{ name: "numeric metadata match cannot crowd out an unheaded body", text: longMetadata + "The 55 pending embeddings were refreshed.", expected: "The 55 pending embeddings were refreshed." },
		{ name: "metadata-only match falls back to first body paragraph", text: longMetadata + "The archive is ready.\n\nSecond paragraph.", expected: "The archive is ready." },
		{ name: "body matches still select the relevant paragraph", text: longMetadata + "Unrelated opening.\n\nResolved issue 55 in the archive.", expected: "Resolved issue 55 in the archive." },
		{ name: "BOM CRLF and alternate frontmatter terminator", text: "\uFEFF---\r\nmessageId: 55\r\n...\r\n\r\nArchive body.", expected: "Archive body." },
		{ name: "invalid but delimited YAML is still excluded", text: "---\nmessageId: [55\n---\n\nArchive body.", expected: "Archive body." },
		{ name: "frontmatter-only note has an empty snippet", text: longMetadata, expected: "" },
		{ name: "unterminated frontmatter is not exposed as body", text: "---\nmessageId: 55\nprovenance: unfinished", expected: "" },
		{ name: "notes without frontmatter retain paragraph selection", text: "Opening.\n\nIssue 55 is resolved.", expected: "Issue 55 is resolved." },
		{ name: "body remains bounded in UTF-8 bytes", text: longMetadata + "55 " + "界".repeat(500), expected: undefined },
	];
	for (const item of cases) await t.test(item.name, async (t) => {
		const current = await fixture(t);
		await writeFile(join(current.notes, "alpha.md"), item.text);
		const service = current.service; const config = current.config;
		await ready(current);
		const result = await service.search({ store: "memory", query: "55", mode: "lexical", includeContent: true, freshness: "require-current-lexical" });
		assert.equal(result.data.returned, 1);
		const hit = result.data.hits[0];
		assert.equal(hit.sourceRevision, hit.indexedRevision);
		assert.doesNotMatch(hit.snippet!, /messageId:|provenance:|\uFFFD/);
		if (item.expected !== undefined) { assert.equal(hit.snippet, item.expected); assert.equal(hit.truncated, false); }
		else { assert.ok(hit.snippet!.startsWith("55 界")); assert.ok(Buffer.byteLength(hit.snippet!) <= 1024); assert.equal(hit.truncated, true); }
		assert.equal(await readFile(join(current.notes, "alpha.md"), "utf8"), item.text);
	});
});

test('unsupported backend path candidates are dropped without hiding valid hits',async t=>{
 const f=await fixture(t);await writeFile(join(f.notes,'bad?name.md'),'Copper heron');await ready(f);const result=await f.service.search({store:'memory',query:'copper',mode:'lexical'});assert.equal(result.data.returned,1);assert.equal(result.data.dropped,1);assert.equal(result.data.examined,2);assert.ok(result.warnings.some(w=>w.code==='STALE_CANDIDATE_DROPPED'));await assert.rejects(f.service.search({store:'memory',query:'copper',mode:'lexical',freshness:'require-current-lexical'}),{code:'STALE_INDEX'});
});
