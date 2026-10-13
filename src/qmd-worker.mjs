import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";

process.umask(0o077);
const idleMs = Number(process.argv[2]?.split("=")[1] ?? 300_000);
let store, identity, active, timer, closing = false;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const statusShape = s => ({totalDocuments:s.totalDocuments,needsEmbedding:s.needsEmbedding,hasVectorIndex:s.hasVectorIndex});
async function close() { if (closing) return; closing=true; clearTimeout(timer); try { await store?.close(); } finally { process.exit(0); } }
function idle() { timer=setTimeout(()=>void close(),idleMs);timer.unref(); }
async function execute(r) {
 try {
  const key=JSON.stringify([r.sdkUrl,r.dbPath,r.config]);
  if(identity && identity!==key) throw new Error("binding_changed");
  if(!store){ const sdk=await import(r.sdkUrl);store=await sdk.createStore({dbPath:r.dbPath,config:r.config});identity=key; }
  let data;
  if(r.operation==='search') {
   const options={collection:r.collection,limit:r.limit};
   const hits=r.mode==='lexical'?await store.searchLex(r.query,options):r.mode==='semantic'?await store.searchVector(r.query,options):await store.search({query:r.query,...options,minScore:r.minScore,rerank:true});
   const results=[];
   for(const hit of hits.slice(0,500)) {
    const uri=hit.filepath ?? hit.file;
    const body=await store.getDocumentBody(uri);
    if(typeof body!=='string')continue;
    results.push({uri,score:hit.score,indexedRevision:createHash('sha256').update(body).digest('hex')});
   }
   data={results,status:statusShape(await store.getStatus())};
  } else if(r.operation==='refresh') {
   const report=progress=>send({version:2,id:r.id,type:'progress',progress});
   const update=await store.update({collections:r.collections,onProgress:p=>report({phase:'updating',documents:{completed:p.current,total:p.total}})});
   const embed=r.semantic?await store.embed({onProgress:p=>report({phase:'embedding',chunks:{completed:p.chunksEmbedded,total:p.totalChunks},bytes:{completed:p.bytesProcessed,total:p.totalBytes},errors:p.errors})}):undefined;
   data={update:{indexed:update.indexed,updated:update.updated,unchanged:update.unchanged,removed:update.removed,skipped:update.skipped ?? 0,needsEmbedding:update.needsEmbedding},embed:embed?{docsProcessed:embed.docsProcessed,chunksEmbedded:embed.chunksEmbedded,errors:embed.errors,durationMs:embed.durationMs}:undefined,status:statusShape(await store.getStatus())};
  } else if(r.operation==='status') data={status:statusShape(await store.getStatus()),health:await store.getIndexHealth(),collections:await store.listCollections()};
  else throw new Error('invalid_operation');
  send({version:2,id:r.id,type:'result',data});
 }catch{send({version:2,id:r.id,type:'error',code:'BACKEND_FAILED'});}
}
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
 if(Buffer.byteLength(line)>1024*1024){void close();return;}
 let r;try{r=JSON.parse(line);}catch{void close();return;}
 if(r.version===2 && r.type==='shutdown'){if(!active)void close();else lines.close();return;}
 // Native SDK has no abort signal. The parent terminates this owned process and waits for exit.
 if(r.version===2 && r.type==='cancel')return;
 if(active || r.version!==2 || !/^[0-9a-f]{32}$/.test(r.id) || typeof r.sdkUrl!=='string' || !r.sdkUrl.startsWith('file:') || !isAbsolute(r.dbPath) || !r.config?.collections || !['search','refresh','status'].includes(r.operation)){void close();return;}
 clearTimeout(timer);active=execute(r).finally(()=>{active=undefined;idle();});
});
lines.on('close',()=>{if(!active)void close();else process.exit(0);});
idle();
