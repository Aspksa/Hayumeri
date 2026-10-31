// Dedicated CI fixture. Uses synthetic vectors ONLY inside this isolated test.
// Production always calls a real Ollama model and a real Qdrant service.
// Do not include in npm test on a user's machine.
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

if(process.env.GITHUB_ACTIONS!=='true') {
  console.log('Semantic integration fixture runs only in GitHub Actions.');
  process.exit(0);
}
const origin='http://127.0.0.1:5187';
const temp=mkdtempSync(join(tmpdir(),'hayumeri-semantic-fixture-'));
const cwd=process.cwd();
const collections=new Map();
let app;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function reply(res,status,result) {
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(JSON.stringify(result));
}
async function json(req) {
  let body='';for await(const part of req)body+=part.toString();
  return body?JSON.parse(body):{};
}
const embeddings=httpServer(async(req,res)=>{
  if(req.url==='/api/tags')return reply(res,200,{models:[{name:'embeddinggemma:latest'}]});
  if(req.url==='/api/embed'&&req.method==='POST') {
    const data=await json(req);
    const inputs=Array.isArray(data.input)?data.input:[data.input];
    return reply(res,200,{embeddings:inputs.map(input=>{
      const text=String(input).toLowerCase();
      return text.includes('транспорт')||text.includes('автомобиль')
        ?[1,0,0,0,0,0,0,0]:[0,1,0,0,0,0,0,0];
    })});
  }
  reply(res,404,{});
});
function equalFilter(p,filter){
  const match=(rule)=>p[rule.key]===rule.match.value;
  return (filter?.must??[]).every(match)&&!(filter?.must_not??[]).some(match);
}
const qdrant=httpServer(async(req,res)=>{
  if(req.headers['api-key']!=='f'.repeat(64))return reply(res,401,{});
  const path=new URL(req.url,'http://127.0.0.1').pathname;
  const parts=path.split('/').filter(Boolean);
  const name=parts[1];
  if(parts[0]!=='collections')return reply(res,404,{});
  const exists=collections.has(name);
  if(parts.length===2&&req.method==='GET')return exists?reply(res,200,{result:{status:'green'}}):reply(res,404,{});
  if(parts.length===2&&req.method==='PUT') {
    if(!exists)collections.set(name,new Map());
    return reply(res,200,{result:true});
  }
  if(!exists)return reply(res,404,{});
  const points=collections.get(name);
  const body=await json(req);
  if(parts[2]==='points'&&parts.length===3&&req.method==='PUT') {
    for(const point of body.points)points.set(point.id,point);
    return reply(res,200,{result:{status:'completed'}});
  }
  if(parts[3]==='delete') {
    for(const [id,point] of points) {
      if(equalFilter(point.payload,body.filter))points.delete(id);
    }
    return reply(res,200,{result:{status:'completed'}});
  }
  if(parts[3]==='query') {
    const cosine=(a,b)=>{
      const dot=a.reduce((v,x,i)=>v+x*b[i],0);
      const ma=Math.hypot(...a),mb=Math.hypot(...b);
      return dot/(ma*mb);
    };
    const hits=[...points.values()].filter(p=>equalFilter(p.payload,body.filter))
      .map(p=>({id:p.id,score:cosine(p.vector,body.query),payload:p.payload}))
      .sort((a,b)=>b.score-a.score).slice(0,body.limit);
    return reply(res,200,{result:{points:hits}});
  }
  reply(res,404,{});
});
async function listen(server,port){
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
}
async function api(path,body) {
  const response=await fetch(origin+path,{method:body?'POST':'GET',
    headers:body?{'Content-Type':'application/json','X-Hayumeri-Action':'1',Origin:origin}:{},
    body:body?JSON.stringify(body):undefined});
  const json=await response.json();
  if(!response.ok)throw new Error(path+' -> '+response.status+': '+JSON.stringify(json));
  return json;
}
async function until(predicate){
  for(let i=0;i<150;i++){if(await predicate())return;await wait(150);}
  throw new Error('Semantic fixture did not synchronize notes');
}
try{
  await Promise.all([listen(embeddings,11434),listen(qdrant,6333)]);
  process.chdir(temp);
  const fs=await import('node:fs');
  fs.writeFileSync(join(temp,'.env.nosql'),'QDRANT_API_KEY='+'f'.repeat(64)+'\n','utf8');
  const [{createServer},{hayumeriWorkspaceApi},{hayumeriSemanticMemoryApi}]=await Promise.all([
    import('vite'),import('../scripts/workspace-api.ts'),import('../scripts/semantic-memory-api.ts')
  ]);
  app=await createServer({configFile:false,root:temp,server:{host:'127.0.0.1',port:5187,strictPort:true},
    plugins:[hayumeriWorkspaceApi(),hayumeriSemanticMemoryApi()]});
  await app.listen();
  await until(async()=>{const s=await api('/api/memory/status');return s.state==='ready';});
  const initial=await api('/api/workspace/data');
  const note={id:'test1',title:'Транспорт',content:'Автомобиль и ремонт двигателя',updatedAt:new Date().toISOString()};
  await api('/api/workspace/data',{...initial,notes:[note]});
  await until(async()=>{const s=await api('/api/memory/status');return s.state==='ready'&&s.indexed===1;});
  const result=await api('/api/memory/search',{query:'транспорт'});
  assert.equal(result.hits[0]?.sourceId,note.id);
  assert.equal(result.hits[0]?.title,note.title);
  const fresh=await api('/api/workspace/data');
  await api('/api/workspace/data',{...fresh,notes:[{...note,title:'Музыка',content:'Песни, гитара и концерт',updatedAt:new Date().toISOString()}]});
  await until(async()=>{
    const s=await api('/api/memory/status');
    if(s.state!=='ready')return false;
    const q=await api('/api/memory/search',{query:'песня'});
    return q.hits[0]?.title==='Музыка';
  });
  const beforeDelete=await api('/api/workspace/data');
  await api('/api/workspace/data',{...beforeDelete,notes:[]});
  await until(async()=>{
    const s=await api('/api/memory/status');
    const result=await api('/api/memory/search',{query:'музыка'});
    return s.indexed===0&&result.hits.length===0;
  });
  console.log('[OK] Local semantic API: note create -> embed -> Qdrant search -> edit -> remove.');
}finally{
  if(app)await app.close();
  await Promise.all([new Promise(resolve=>embeddings.close(resolve)),new Promise(resolve=>qdrant.close(resolve))]);
  process.chdir(cwd);
  rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
