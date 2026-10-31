import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Production uses a real local Ollama embedding model and authenticated Qdrant.
 * No fake embeddings, no cloud uploads and no deletion of original notes. */
const root = process.cwd();
const runtime = join(root, '.runtime');
const workspaceFile = join(runtime, 'workspace-data.json');
const indexFile = join(runtime, 'semantic-index.json');
const secretFile = join(root, '.env.nosql');
const OLLAMA = 'http://127.0.0.1:11434';
const QDRANT = 'http://127.0.0.1:6333';
const MODEL = 'embeddinggemma';
const namespace = 'personal_notes';
type Note = {id:string;title:string;content:string;updatedAt:string};
type IndexState = {schema:1;model:string;collection:string;revisions:Record<string,string>};
type Status = {state:'waiting'|'preparing'|'indexing'|'ready'|'error';message:string; indexed:number;total:number;model:string;updatedAt:string|null};
const digest = (value:string):string => createHash('sha256').update(value,'utf8').digest('hex');
const defaultIndex = (): IndexState => ({schema:1,model:MODEL,collection:'',revisions:{}});
let index: IndexState = defaultIndex();
let status: Status = {state:'waiting',message:'Проверка локальной модели и Qdrant…',indexed:0,total:0,model:MODEL,updatedAt:null};
let busy = false;
let wake: ReturnType<typeof setTimeout>|null = null;
let interval: ReturnType<typeof setInterval>|null = null;
let live = false;
let installedModel = false;
let pullTried = false;

export function splitNote(text:string):string[] {
  const clean=text.replace(/\r\n/g,'\n').trim();
  if (!clean) return [];
  const result:string[]=[];
  let start=0;
  while(start<clean.length) {
    let end=Math.min(clean.length,start+1200);
    if(end<clean.length) {
      const breakPoint=clean.lastIndexOf('\n',end);
      if(breakPoint>start+700) end=breakPoint;
    }
    const part=clean.slice(start,end).trim();
    if(part) result.push(part);
    if(end>=clean.length) break;
    start=Math.max(start+1,end-100);
  }
  return result;
}
function notes():Note[] {
  if(!existsSync(workspaceFile))return [];
  if(statSync(workspaceFile).size>1_500_000) throw new Error('Локальный файл заметок слишком большой.');
  const obj:unknown=JSON.parse(readFileSync(workspaceFile,'utf8'));
  if(!obj||typeof obj!=='object'||!Array.isArray((obj as {notes?:unknown}).notes)) throw new Error('Данные заметок повреждены.');
  const all=(obj as {notes:unknown[]}).notes;
  if(all.length>500||all.some(value=>!value||typeof value!=='object'
    ||typeof (value as Note).id!=='string'
    ||!/^[a-zA-Z0-9_-]{1,80}$/.test((value as Note).id)
    ||typeof (value as Note).title!=='string'
    ||typeof (value as Note).content!=='string'
    ||typeof (value as Note).updatedAt!=='string'))throw new Error('Неверный формат заметок.');
  return all as Note[];
}
function readIndex():IndexState {
  if(!existsSync(indexFile))return defaultIndex();
  if(statSync(indexFile).size>150000)throw new Error('Индексный журнал превышает допустимый размер.');
  const obj:unknown=JSON.parse(readFileSync(indexFile,'utf8'));
  if(!obj||typeof obj!=='object')throw new Error('Некорректный журнал индексации.');
  const data=obj as IndexState;
  if(data.schema!==1||data.model!==MODEL||typeof data.collection!=='string'
    ||!data.revisions||typeof data.revisions!=='object'||Array.isArray(data.revisions)
    ||Object.entries(data.revisions).some(([key,value])=>!/^[a-zA-Z0-9_-]{1,80}$/.test(key)||!/^[a-f0-9]{64}$/.test(value)))
    throw new Error('Повреждён журнал индексации. Исходные заметки не затронуты.');
  return data;
}
function writeIndex():void {
  mkdirSync(runtime,{recursive:true});
  const tmp=join(runtime,'semantic-index-'+process.pid+'.tmp');
  writeFileSync(tmp,JSON.stringify(index),{encoding:'utf8',flag:'w'});
  renameSync(tmp,indexFile);
}
function key():string {
  if(!existsSync(secretFile))throw new Error('Qdrant не настроена — ожидается запуск четырёх баз.');
  const match=readFileSync(secretFile,'utf8').match(/^QDRANT_API_KEY=([a-f0-9]{64})$/m);
  if(!match)throw new Error('Ключ Qdrant отсутствует или некорректен.');
  return match[1]!;
}
async function jsonFetch(url:string,options:RequestInit={},deadline=15000):Promise<any> {
  const response=await fetch(url,{...options,signal:AbortSignal.timeout(deadline)});
  if(!response.ok)throw new Error('Локальный сервис недоступен (HTTP '+response.status+').');
  return response.json();
}
async function qdrant(path:string,method:'GET'|'PUT'|'POST'='GET',body?:unknown):Promise<any> {
  return jsonFetch(QDRANT+path,{method,headers:{'api-key':key(),...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
}
function diskEnough():boolean {
  try {const fs=statfsSync(root);return fs.bavail*fs.bsize>2*1024*1024*1024;}catch{return false;}
}
async function embed(texts:string[]):Promise<number[][]> {
  if(!installedModel){
    const server=await jsonFetch(OLLAMA+'/api/tags',{},3000);
    const models=Array.isArray(server.models)?server.models:[];
    installedModel=models.some((entry:{name?:string})=>entry.name===MODEL||entry.name===MODEL+':latest');
    if(!installedModel){
      if(pullTried)throw new Error('Модель эмбеддингов ещё не готова. Проверьте Ollama.');
      if(!diskEnough())throw new Error('Для загрузки модели необходимо не менее 2 ГиБ свободного места на диске проекта.');
      pullTried=true;
      status={...status,state:'preparing',message:'Ollama загружает локальную модель embeddinggemma. Первый запуск требует интернет.'};
      await jsonFetch(OLLAMA+'/api/pull',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({model:MODEL,stream:false})},900000);
      installedModel=true;
    }
  }
  const answer=await jsonFetch(OLLAMA+'/api/embed',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:MODEL,input:texts,truncate:false,keep_alive:'2m'})},120000);
  if(!Array.isArray(answer.embeddings)||answer.embeddings.length!==texts.length
    ||answer.embeddings.some((vector:unknown)=>!Array.isArray(vector)||vector.length<8
      ||vector.length>8192||vector.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v))))
    throw new Error('Ollama вернула некорректные эмбеддинги.');
  return answer.embeddings as number[][];
}
function collectionName(dimension:number):string {
  return 'hayumeri_memory_v1_'+digest(MODEL).slice(0,20)+'_d'+dimension;
}
async function prepareCollection(dimension:number):Promise<string>{
  const name=collectionName(dimension);
  let exists=false;
  try{await qdrant('/collections/'+name);exists=true;}catch(error){
    if(!(error instanceof Error)||!error.message.includes('404'))throw error;
  }
  if(!exists){
    await qdrant('/collections/'+name,'PUT',{
      vectors:{size:dimension,distance:'Cosine',on_disk:true},
      hnsw_config:{on_disk:true},on_disk_payload:true
    });
    index={...defaultIndex(),collection:name};
    writeIndex();
  }
  if(index.collection!==name){index={...defaultIndex(),collection:name};writeIndex();}
  return name;
}
function idOf(noteId:string,chunk:number):string{
  const h=digest(JSON.stringify([MODEL,namespace,noteId,'part'+chunk]));
  return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}
function filter(noteId:string){return {must:[
  {key:'namespace',match:{value:namespace}},{key:'sourceId',match:{value:noteId}},
  {key:'modelId',match:{value:MODEL}}
]};}
async function forget(name:string,id:string):Promise<void>{
  await qdrant('/collections/'+name+'/points/delete?wait=true','POST',{filter:filter(id)});
}
async function store(name:string,note:Note,sourceHash:string):Promise<void>{
  const texts=splitNote((note.title+'\n'+note.content).trim());
  if(!texts.length)return;
  const batches:{id:string;vector:number[];payload:Record<string,unknown>}[]=[];
  for(let i=0;i<texts.length;i+=4) {
    const part=texts.slice(i,i+4);
    const embeddings=await embed(part);
    for(let j=0;j<embeddings.length;j++) {
      const n=i+j;
      if(collectionName(embeddings[j]!.length)!==name) throw new Error('Размерность модели изменилась. Индекс не изменён.');
      batches.push({
        id:idOf(note.id,n),vector:embeddings[j]!,
        payload:{namespace,modelId:MODEL,sourceId:note.id,chunkId:'part'+n,
          kind:'note',sourceHash,revision:sourceHash,recordedAt:note.updatedAt,
          preview:texts[n]!.slice(0,300)}
      });
    }
  }
  // New points first. A later failure keeps original notes and allows retry.
  for(let offset=0;offset<batches.length;offset+=32){
    await qdrant('/collections/'+name+'/points?wait=true','PUT',{points:batches.slice(offset,offset+32)});
  }
  // Remove obsolete chunks from older revisions via source-scoped listing.
  const keep=new Set(batches.map(point=>point.id));
  let cursor:unknown=undefined;
  do {
    const data=await qdrant('/collections/'+name+'/points/scroll','POST',{
      filter:filter(note.id),limit:128,with_payload:false,with_vector:false,
      ...(cursor===undefined?{}:{offset:cursor})
    });
    const result=data.result??{};
    const stale=(result.points??[]).filter((p:{id:string})=>!keep.has(String(p.id)))
      .map((p:{id:string})=>p.id);
    if(stale.length)await qdrant('/collections/'+name+'/points/delete?wait=true','POST',{points:stale});
    cursor=result.next_page_offset;
  } while(cursor!==null&&cursor!==undefined);
}
async function reconcile():Promise<void>{
  if(busy||!live)return;
  busy=true;
  try{
    const all=notes();
    status={...status,state:'preparing',message:'Проверка модели эмбеддингов и векторной базы.',total:all.length};
    const probe=await embed(['проверка локальной модели']);
    const name=await prepareCollection(probe[0]!.length);
    status={...status,state:'indexing',message:'Обновление индекса заметок.',total:all.length};
    const current=new Map(all.map(n=>[n.id,digest(n.title+'\n'+n.content)]));
    // Remove deleted originals from Qdrant; never alter the actual notes.
    for(const id of Object.keys(index.revisions)){
      if(!current.has(id)){await forget(name,id);delete index.revisions[id];writeIndex();}
    }
    let processed=0;
    for(const note of all){
      const sourceHash=current.get(note.id)!;
      if(index.revisions[note.id]===sourceHash)continue;
      if(!note.title.trim()&&!note.content.trim())continue;
      await store(name,note,sourceHash);
      index.revisions[note.id]=sourceHash;
      writeIndex();
      if(++processed>=4)break; // small background queue per cycle
    }
    status={state:'ready',message:processed?'Фрагменты заметок индексируются автоматически.':'Индекс заметок синхронизирован.',
      indexed:Object.keys(index.revisions).length,total:all.length,model:MODEL,updatedAt:new Date().toISOString()};
  }catch(error){
    const message=error instanceof Error?error.message:'Неизвестная ошибка.';
    status={...status,state:'error',message:message.includes('fetch failed')||message.includes('ECONNREFUSED')
      ? 'Не найдены Ollama или Qdrant. Установите Ollama один раз; Qdrant запускается автоматически.'
      :message.slice(0,180),updatedAt:new Date().toISOString()};
  }finally{busy=false;}
}
export function signalNotesChanged():void{
  if(!live||wake)return;
  wake=setTimeout(()=>{wake=null;void reconcile();},1800);
}
async function search(query:string):Promise<unknown[]>{
  if(!query.trim()||query.length>500)throw new Error('Запрос должен быть от 1 до 500 символов.');
  if(!index.collection)throw new Error('Индекс ещё не подготовлен.');
  const vectors=await embed([query]);
  if(collectionName(vectors[0]!.length)!==index.collection)throw new Error('Смена модели требует повторной индексации.');
  const out=await qdrant('/collections/'+index.collection+'/points/query','POST',{
    query:vectors[0],limit:30,with_payload:true,with_vector:false,
    filter:{must:[{key:'namespace',match:{value:namespace}},{key:'modelId',match:{value:MODEL}}]}
  });
  const actual=new Map(notes().map(n=>[n.id,n]));
  const seen=new Set<string>();
  const hits:unknown[]=[];
  for(const item of out.result?.points??[]){
    const p=item.payload??{};
    const original=actual.get(p.sourceId);
    if(!original||index.revisions[p.sourceId]!==digest(original.title+'\n'+original.content)
      ||p.sourceHash!==index.revisions[p.sourceId]||seen.has(p.sourceId))continue;
    seen.add(p.sourceId);
    hits.push({sourceId:original.id,title:original.title,updatedAt:original.updatedAt,
      score:typeof item.score==='number'?item.score:0,preview:typeof p.preview==='string'?p.preview:''});
    if(hits.length>=8)break;
  }
  return hits;
}
function respond(res:ServerResponse,statusCode:number,result:unknown):void{
  res.writeHead(statusCode,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(result));
}
export function hayumeriSemanticMemoryApi():Plugin{
  return {
    name:'hayumeri-semantic-memory',
    apply:'serve',
    configureServer(server){
      try{index=readIndex();}catch{index=defaultIndex();}
      live=true;
      const start=()=>{signalNotesChanged();interval=setInterval(()=>{void reconcile();},30000);};
      if(server.httpServer?.listening)start();
      else server.httpServer?.once('listening',start);
      server.httpServer?.once('close',()=>{
        live=false;if(interval)clearInterval(interval);if(wake)clearTimeout(wake);
      });
      server.middlewares.use('/api/memory',async(req,res,next)=>{
        const url=new URL(req.url??'/', 'http://127.0.0.1');
        if(url.pathname==='/status'&&req.method==='GET'){
          respond(res,200,status);return;
        }
        if(url.pathname!=='/search'){next();return;}
        if(req.method!=='POST'){respond(res,405,{error:'Метод не поддерживается.'});return;}
        const host=req.headers.host??'';
        if(!/^127\.0\.0\.1:\d+$/.test(host)||req.headers.origin!=='http://'+host
          ||req.headers['x-hayumeri-action']!=='1'
          ||req.headers['content-type']?.startsWith('application/json')!==true
          ||req.headers['sec-fetch-site']==='cross-site'){
          respond(res,403,{error:'Поисковый запрос отклонён.'});return;
        }
        try{
          let length=0;let raw='';
          for await(const part of req){length+=(part as Buffer).length;
            if(length>4096)throw new Error('Слишком длинный запрос.');
            raw+=(part as Buffer).toString('utf8');}
          const body:unknown=JSON.parse(raw);
          const query=typeof body==='object'&&body!==null&&'query'in body
            ?(body as {query?:unknown}).query:undefined;
          if(typeof query!=='string'||!query.trim()||query.length>500){
            respond(res,400,{error:'Укажите короткий поисковый запрос.'});return;
          }
          const hits=await search(query);
          respond(res,200,{hits,model:MODEL,source:'local-notes'});
        }catch(error){
          respond(res,503,{error:error instanceof Error?error.message.slice(0,200):'Поиск временно недоступен.'});
        }
      });
    }
  };
}
