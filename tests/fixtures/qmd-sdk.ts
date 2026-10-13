/** Public SDK contract fixture: no backend private exports or internal handles. */
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
type Doc={path:string;text:string};
export async function createStore({dbPath,config}:any) {
 const root=dirname(dbPath).endsWith('/backend')?dirname(dirname(dbPath)):dirname(dbPath),log=(event:string)=>appendFileSync(join(root,'calls.log'),event+'\n');
 let closed=false;log('open');
 const read=():any=>existsSync(dbPath)?JSON.parse(readFileSync(dbPath,'utf8')):{collections:{},pending:0,vector:false};
 const save=(state:any)=>writeFileSync(dbPath,JSON.stringify(state));
 const behavior=()=>existsSync(join(root,'behavior.json'))?JSON.parse(readFileSync(join(root,'behavior.json'),'utf8')):{};
 const scan=(root:string,prefix=''):Doc[]=>readdirSync(join(root,prefix),{withFileTypes:true}).flatMap(e=>{const path=prefix?prefix+'/'+e.name:e.name;return e.isDirectory()?scan(root,path):e.isFile()&&path.endsWith('.md')?[{path,text:readFileSync(join(root,path),'utf8')}]:[];});
 const count=(s:any)=>Object.values(s.collections).reduce((n:number,docs:any)=>n+docs.length,0);
 const status=async()=>{const s=read();return {totalDocuments:count(s),needsEmbedding:s.pending,hasVectorIndex:s.vector};};
 const search=async(query:string,opts:any)=>{log('search:'+query);if(behavior().searchDelay)await new Promise(r=>setTimeout(r,behavior().searchDelay));const s=read();return (s.collections[opts.collection]??[]).filter((d:Doc)=>d.text.toLowerCase().includes(query.toLowerCase())).slice(0,opts.limit).map((d:Doc)=>({filepath:`qmd://${opts.collection}/${d.path}`,score:1}));};
 const api={
  async update({collections,onProgress}:any){log('update');if(behavior().updateDelay)await new Promise(r=>setTimeout(r,behavior().updateDelay));if(behavior().updateError)throw new Error('disk full');const s=read();for(const name of collections){const docs=scan(config.collections[name].path);if(JSON.stringify(docs)!==JSON.stringify(s.collections[name]))s.pending=docs.length;s.collections[name]=docs;onProgress?.({collection:name,current:docs.length,total:docs.length});}save(s);return {indexed:count(s),updated:0,unchanged:0,removed:0,needsEmbedding:s.pending};},
  async embed({onProgress}:any){log('embed');const b=behavior();onProgress?.({chunksEmbedded:0,totalChunks:2,bytesProcessed:0,totalBytes:20,errors:0});await new Promise(r=>setTimeout(r,b.embedDelay??30));if(b.embedError)throw new Error('embedding failed');onProgress?.({chunksEmbedded:1,totalChunks:1,bytesProcessed:10,totalBytes:10,errors:0});const s=read();if(!b.partial){s.pending=0;s.vector=true;save(s);}return {docsProcessed:1,chunksEmbedded:1,errors:b.partial?1:0,durationMs:30};},
  searchLex:search,searchVector:search,search:({query,...opts}:any)=>search(query,opts),
  async getDocumentBody(uri:string){const s=read();for(const [name,docs]of Object.entries(s.collections))for(const d of docs as Doc[])if(uri===`qmd://${name}/${d.path}`)return d.text;return null;},
  getStatus:status,async getIndexHealth(){const s=await status();return {totalDocs:s.totalDocuments,needsEmbedding:s.needsEmbedding,daysStale:0};},
  async listCollections(){const s=read();return Object.entries(s.collections).map(([name,docs]:any)=>({name,active_count:docs.length}));},
  async close(){if(closed)throw new Error('double close');closed=true;log('close');},
 };
 return new Proxy(api,{get(target,key){if(key==="then")return undefined;if(!(key in target))throw new Error('unsupported SDK access: '+String(key));return target[key as keyof typeof target];}});
}
