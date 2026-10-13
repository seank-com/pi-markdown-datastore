import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,realpath,rename,rm,writeFile } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('qualified public SDK and CLI full paths share exact source identity', {skip:!process.env.DATASTORE_QMD_PACKAGE},async t=>{
 const pkg=process.env.DATASTORE_QMD_PACKAGE!;const metadata=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));assert.equal(metadata.version,'2.8.3');
 const {createStore}=await import(pathToFileURL(resolve(pkg,metadata.exports['.'].import)).href);
 const base=await realpath(await mkdtemp(join(tmpdir(),'datastore-cli-')));t.after(()=>rm(base,{recursive:true,force:true}));const notes=join(base,'notes'),cache=join(base,'cache'),config=join(base,'config');await mkdir(notes);await mkdir(join(base,'other'));await writeFile(join(base,'other','outside.md'),'Copper other collection');await mkdir(join(cache,'qmd'),{recursive:true});await mkdir(config);
 const paths=['2026-10-13.md','Case Name.md','case-name.md','café.md','100%25.md','punctuation!.md','duplicate.md'];
 const body='\uFEFF# Copper\r\n\r\nCopper heron.\r\n';for(const p of paths)await writeFile(join(notes,p),body);await writeFile(join(config,'compat.yml'),JSON.stringify({collections:{notes:{path:notes,pattern:'**/*.md'},other:{path:join(base,'other'),pattern:'**/*.md'}}}));
 const store=await createStore({dbPath:join(cache,'qmd','compat.sqlite'),configPath:join(config,'compat.yml')});t.after(()=>store.close());await store.update();
 const hits=await store.searchLex('copper',{collection:'notes',limit:20});assert.deepEqual(hits.map((h:any)=>h.filepath.slice('qmd://notes/'.length)).sort(),paths.sort());for(const hit of hits)assert.equal(await store.getDocumentBody(hit.filepath),body);
 const env={HOME:process.env.HOME,PATH:dirname(process.execPath)+':/usr/bin:/bin',XDG_CACHE_HOME:cache,QMD_CONFIG_DIR:config};const cli=resolve(pkg,metadata.bin.qmd);
 const run=()=>JSON.parse(execFileSync('/bin/sh',[cli,'--index','compat','search','copper','--format','json','--full-path','-c','notes','-n','20'],{cwd:base,env,timeout:10000,maxBuffer:1024*1024,encoding:'utf8'}));
 assert.deepEqual(run().map((h:any)=>resolve(base,h.file)).sort(),paths.map(p=>join(notes,p)).sort());
 await rename(join(notes,'Case Name.md'),join(notes,'renamed.md'));await rm(join(notes,'100%25.md'));await store.update();assert.ok(run().some((h:any)=>h.file==='./notes/renamed.md'));
});
