const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
(async () => {
  const base = path.resolve('.runtime/formula-cache-unit');
  await fsp.rm(base,{recursive:true,force:true}); await fsp.mkdir(base,{recursive:true});
  const items = new Map(); let clipboard='initial', requests=0;
  const errors=[];
  const scope=vm.createContext({TextEncoder, Cc:{
    '@mozilla.org/security/hash;1':{createInstance(){let hash;return {SHA256:1,init(){hash=crypto.createHash('sha256');},update(bytes){hash.update(bytes);},finish(){return hash.digest('latin1');}};}},
    '@mozilla.org/widget/clipboardhelper;1':{getService:()=>({copyString:text=>{clipboard=text;}})}
  },Ci:{},PathUtils:{join:path.join,filename:path.basename},IOUtils:{
    makeDirectory:async p=>fsp.mkdir(p,{recursive:true}),getChildren:async p=>(await fsp.readdir(p)).map(n=>path.join(p,n)),
    readUTF8:p=>fsp.readFile(p,'utf8'),read:async p=>new Uint8Array(await fsp.readFile(p)),
    writeUTF8:async(p,data,options={})=>{await fsp.writeFile(options.tmpPath||p,data);if(options.tmpPath)await fsp.rename(options.tmpPath,p);},
    setPermissions:(p,mode)=>fsp.chmod(p,mode),remove:p=>fsp.rm(p,{force:true}),stat:async p=>{const s=await fsp.stat(p);return{size:s.size,lastModified:s.mtimeMs};}
  },Zotero:{Items:{get:id=>items.get(id),getByLibraryAndKeyAsync:async(lib,key)=>[...items.values()].find(i=>i.libraryID===lib&&i.key===key)},logError:e=>errors.push(String(e))}});
  for(const file of ['formula-cache','formulas'])vm.runInContext(fs.readFileSync('addon/content/'+file+'.js','utf8'),scope);
  const parent=(id,key)=>{const item={id,key,libraryID:1,deleted:false,isRegularItem:()=>true,getField:()=>key};items.set(id,item);return item;};
  const pdf=async(id,key,owner,content)=>{const file=path.join(base,key+'.pdf');await fsp.writeFile(file,content);const item={id,key,libraryID:1,deleted:false,parentID:owner?.id,parentKey:owner?.key,isRegularItem:()=>false,isPDFAttachment:()=>true,getField:()=>key,getFilePathAsync:async()=>file};Object.defineProperty(item,'parentItem',{get:()=>items.get(item.parentID)});items.set(id,item);return item;};
  const owner=parent(10,'PAPER_A'),otherOwner=parent(20,'PAPER_B');
  const source=await pdf(1,'SOURCE',owner,'source content');const translated=await pdf(2,'TRANSLATED',owner,'translated content');
  const other=await pdf(3,'SOURCE_B',otherOwner,'source content');
  const bridge={alive:true,runtime:{base},library:{records:[]},getKey:()=> 'fixture',pref:()=> 'https://api.deepseek.com',request:async()=>{requests++;await new Promise(r=>setTimeout(r,5));return{latex:'x_i^2'};}};
  let cache=bridge.formulaCache=new scope.FormulaCache(bridge);await cache.load();
  let formulas=new scope.FormulaClipboard(bridge);
  const selection={text:'x2',glyphs:[{c:'x',page:0,rect:[0,0,5,10]},{c:'2',page:0,rect:[5,7,9,13]}]};
  await cache.link(source,translated);
  assert.equal(await formulas.copy({itemID:1},selection,false),'$x_i^2$');
  assert.equal(await formulas.copy({itemID:2},selection,true),'$$x_i^2$$');assert.equal(requests,1);
  assert.equal((await fsp.readdir(cache.root)).filter(n=>n.endsWith('.json')).length,1,'one JSON shared by original and translation');
  const raw=await fsp.readFile(path.join(cache.root,(await cache.list())[0].id+'.json'),'utf8');assert(!raw.includes('fixture'));
  const second={text:'y2',glyphs:[]};await Promise.all([formulas.copy({itemID:1},second,false),formulas.copy({itemID:2},second,true)]);assert.equal(requests,2,'simultaneous copies share one provider request');
  cache=bridge.formulaCache=new scope.FormulaCache(bridge);await cache.load();formulas=new scope.FormulaClipboard(bridge);bridge.getKey=()=>'';
  assert.equal(await formulas.copy({itemID:2},selection,false),'$x_i^2$');assert.equal(requests,2,'restart/upgrade cache hit needs no API key');bridge.getKey=()=> 'fixture';
  source.deleted=true;await cache.reconcile();assert.equal((await cache.list()).length,1,'original deletion keeps paper cache');
  const third=await pdf(4,'TRANSLATED_B',owner,'translated second');await cache.link(translated,third);translated.deleted=true;await cache.reconcile();assert.equal((await cache.list()).length,1,'one translated deletion retains other references');
  await formulas.copy({itemID:3},selection,false);owner.deleted=true;await cache.reconcile();assert.equal((await cache.list()).length,1,'other paper retains shared original-content cache');
  otherOwner.deleted=true;await cache.reconcile();assert.equal((await cache.list()).length,0,'last paper deletion removes unreferenced JSON');
  owner.deleted=false;source.deleted=false;await formulas.copy({itemID:1},selection,false);owner.deleted=true;
  cache=bridge.formulaCache=new scope.FormulaCache(bridge);await cache.load();assert.equal((await cache.list()).length,0,'startup cleans deletions while disabled');
  owner.deleted=false;const context=await cache.context({itemID:1});await cache.store(context,cache.key(selection),selection,'x_i^2');
  const originalBytes=await fsp.readFile(await source.getFilePathAsync());await cache.clear(context.id);assert.equal((await cache.list()).length,0);assert.deepEqual(await fsp.readFile(await source.getFilePathAsync()),originalBytes,'manual clear preserves PDF');
  let release,started;const start=new Promise(r=>{started=r;});bridge.request=async()=>{requests++;started();await new Promise(r=>{release=r;});return{latex:'z'};};formulas=new scope.FormulaClipboard(bridge);
  const inFlight=formulas.copy({itemID:1},{text:'z',glyphs:[]},false);await start;await cache.clear();release();await inFlight;assert.equal((await cache.list()).length,0,'clear during request cannot repopulate cache');
  const standalone=await pdf(5,'STANDALONE',null,'standalone');const standaloneContext=await cache.context({itemID:5});await cache.store(standaloneContext,'entry',{text:'q'},'q');items.delete(5);await cache.reconcile();assert.equal((await cache.list()).length,0,'standalone deletion removes cache');
  const badID='f'.repeat(64);await fsp.writeFile(path.join(cache.root,badID+'.json'),'{broken');const reloaded=new scope.FormulaCache(bridge);await reloaded.load();assert.equal((await reloaded.list())[0].id,badID);await reloaded.clear(badID);assert.equal((await reloaded.list()).length,0);
  assert.equal(errors.length,0);
  console.log('Persistent JSON, shared attachments, concurrent deduplication, restart, all deletion rules, manual clear and in-flight clear safety passed');
})().catch(error=>{console.error(error);process.exitCode=1;throw error;});
