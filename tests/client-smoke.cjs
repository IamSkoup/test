'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const path=require('node:path');const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/g)].filter(m=>m[2].trim());
const errors=[],timers=[],elements=new Map();
process.on('unhandledRejection',e=>errors.push(e));
function element(id=''){return {id,style:{setProperty(){},removeProperty(){}},dataset:{},value:'',innerHTML:'',textContent:'',children:[],parentElement:null,classList:{add(){},remove(){},toggle(){},contains(){return false;}},addEventListener(){},removeEventListener(){},setAttribute(){},getAttribute(){return null;},removeAttribute(){},appendChild(e){this.children.push(e);return e;},remove(){},insertBefore(e){this.children.push(e);return e;},querySelector(){return null;},querySelectorAll(){return [];},closest(){return null;},focus(){},click(){},pause(){},play:async()=>{},load(){},getBoundingClientRect(){return {top:0,bottom:200,width:400,height:200}},scrollTo(){},scrollIntoView(){},insertAdjacentHTML(){},getContext(){return new Proxy({},{get(){return ()=>{};}});}};}
for(const m of html.matchAll(/\bid="([^"]+)"/g))elements.set(m[1],element(m[1]));
const body=element('body');for(const e of elements.values()){e.parentElement=body;e.parentNode=body;}
const document={body,head:element('head'),documentElement:element('html'),visibilityState:'visible',readyState:'complete',getElementById:id=>elements.get(id)||null,querySelector:sel=>sel.startsWith('#')?elements.get(sel.slice(1))||null:null,querySelectorAll:()=>[],createElement:()=>element(),addEventListener(){},removeEventListener(){},getElementsByTagName:()=>[],createTextNode:t=>({textContent:t})};
function storage(){const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,String(v)),removeItem:k=>m.delete(k),clear:()=>m.clear()};}
const localStorage=storage(),sessionStorage=storage();localStorage.setItem('kp_s','alice');localStorage.setItem('kp_auth',JSON.stringify({nick:'alice',displayName:'Alice'}));
let data={users:{alice:{nick:'alice',displayName:'Alice',job:'Житель',balance:5000,passwordHash:'x'.repeat(64),accountVerified:true,subscription:'none'},bob:{nick:'bob',displayName:'Bob',job:'Житель',balance:10}},news:{},orders:{},municipalTreasury:{balance:0}};
function value(r){return (r.path||'').split('/').filter(Boolean).reduce((o,k)=>o?.[k],data)??null;}
const snapshot=v=>({val:()=>v,exists:()=>v!==null,size:v?Object.keys(v).length:0,forEach:fn=>Object.entries(v||{}).forEach(([key,x])=>fn({...snapshot(x),key}))});
const ref=(db,p)=>({path:p||''});const get=async r=>snapshot(value(r));const set=async()=>{};const update=async()=>{};const push=r=>({...r,key:'key123456'});
const onValue=(r,cb)=>{Promise.resolve().then(()=>cb(snapshot(value(r)))).catch(e=>errors.push(e));return ()=>{};};
const primitives={getDatabase:()=>({}),ref,get,set,update,push,remove:async()=>{},onValue,off(){},serverTimestamp:()=>Date.now(),runTransaction:async(r,fn)=>({committed:false,snapshot:snapshot(value(r))}),query:r=>r,orderByChild:()=>{},equalTo:()=>{},limitToLast:()=>{},onDisconnect:()=>({set:async()=>{},cancel:async()=>{}}),initializeApp:()=>({})};
const sandbox={document,localStorage,sessionStorage,location:new URL('https://example.test/kapani/'),navigator:{userAgent:'Test',platform:'Linux',maxTouchPoints:0,onLine:true,geolocation:{getCurrentPosition(ok,err){err?.({message:'Test: unavailable'});}}},crypto:webcrypto,TextEncoder,TextDecoder,URL,URLSearchParams,Uint8Array,Uint32Array,ArrayBuffer,Blob,File:globalThis.File,FormData,AbortSignal,atob,btoa,Date,Notification:{permission:'default'},screen:{width:400,height:800},innerWidth:400,innerHeight:800,devicePixelRatio:1,
console:{log(){},info(){},debug(){},warn(){},error:(...a)=>errors.push(new Error(a.map(x=>x?.stack||x).join(' ')))},setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout(){},setInterval:()=>1,clearInterval(){},requestAnimationFrame:fn=>{fn();return 1;},cancelAnimationFrame(){},requestIdleCallback:fn=>{timers.push({fn,ms:0});return 1;},addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:false,addEventListener(){},addListener(){}}),getComputedStyle:()=>({display:'block',getPropertyValue:()=>''}),scrollTo(){},alert(){},confirm:()=>true,prompt:()=>null,fetch:async()=>new Response('{}'),Response,Image:function(){},Audio:function(){this.play=async()=>{};this.pause=()=>{};},...primitives,
__import:async url=>url.includes('firebase-auth')?{getAuth:()=>({currentUser:{uid:'alice'}}),setPersistence:async()=>{},browserLocalPersistence:{},onAuthStateChanged:(a,fn)=>{fn(a.currentUser);return ()=>{};}}:url.includes('firebase-functions')?{getFunctions:()=>({}),httpsCallable:()=>async()=>({data:{}})}:{} };
sandbox.window=sandbox;sandbox.globalThis=sandbox;sandbox.self=sandbox;const ctx=vm.createContext(sandbox);
(async()=>{
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../config.js'),'utf8'),ctx);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../functions/subscription-config.js'),'utf8'),ctx);
 for(let i=0;i<scripts.length;i++){
  let code=scripts[i][2].replace(/import\s+\{[\s\S]*?\}\s*from\s*["'][^"']+["'];/g,'').replace(/\bimport\(/g,'__import(');
  try{const r=vm.runInContext(scripts[i][1].includes('module')?`(async()=>{${code}\n})()` : code,ctx,{filename:'inline-'+i});if(r?.then)await r;}catch(e){errors.push(e);}
 }
 for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));
 const startup=errors.splice(0);for(const e of startup)console.error('STARTUP',e.stack);assert.equal(startup.length,0,'Startup errors');
 assert.equal(typeof sandbox.navTo,'function','Navigation is initialized');
 assert.ok(sandbox.KAPANI_READY && typeof sandbox.KAPANI_READY.then==='function','Bootstrap ready promise exists');
 // Navigate every actual page (mock RTDB and DOM, no production writes).
 const pages=[...html.matchAll(/<[^>]+\bid="([^"]+)"[^>]+class="[^"]*\bsection\b[^>]*>/g)].map(m=>m[1]);
 const alt=[...html.matchAll(/<[^>]+class="[^"]*\bsection\b[^>]*"[^>]+\bid="([^"]+)"/g)].map(m=>m[1]);
 for(const page of new Set([...pages,...alt])){try{const result=sandbox.navTo(page);if(result?.then)await result;for(let i=0;i<5;i++)await new Promise(r=>setImmediate(r));}catch(e){errors.push(new Error(page+': '+e.stack));}}
 for(const e of errors)console.error('NAVIGATION',e.stack);assert.equal(errors.length,0,'Navigation errors');
 console.log(`PASS main module, additive modules, startup and ${new Set([...pages,...alt]).size} page routes with mock DOM/RTDB`);
 // Every static inline callback must resolve as a window function.
 const missing=new Set();for(const m of html.matchAll(/\b(?:onclick|onchange|oninput|onsubmit)="([^"]*)"/g)){for(const call of m[1].matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)){const name=call[1];if(call.index>0 && m[1].slice(0,call.index).endsWith('${'))continue;if(['if','for','while','switch','catch','function','alert','confirm','prompt','setTimeout','Number','String','parseInt','parseFloat'].includes(name))continue;if(typeof sandbox[name]!=='function')missing.add(name);}}
 console.log('Static inline callbacks needing review:',[...missing].join(', ')||'none');
})().catch(e=>{console.error(e);process.exitCode=1;});
