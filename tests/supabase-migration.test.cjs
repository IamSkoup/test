'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

const home=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(home,'index.html'),'utf8');
const bridge=fs.readFileSync(path.join(home,'supabase-bridge.js'),'utf8');
const migration=fs.readFileSync(path.join(home,'supabase/001_tree_bridge.sql'),'utf8');

test('the site uses Supabase as the only active client data provider',()=>{
  assert.match(html,/from '\.\/supabase-bridge\.js'/);
  assert.doesNotMatch(html,/from ["']https:\/\/www\.gstatic\.com\/firebasejs/);
  assert.match(bridge,/kp_tree_access/);
  assert.match(migration,/enable row level security/i);
  assert.match(migration,/Protected account field/);
});

test('media uploads use resumable TUS with progress and no Firebase Storage',()=>{
  assert.match(html,/tus-js-client/);
  assert.match(html,/onProgress:\(sent,total\)/);
  assert.match(html,/onError:reject/);
  assert.match(html,/findPreviousUploads/);
  assert.match(html,/kapaniActiveMediaUpload\?\.abort/);
  assert.match(html,/getPendingPhotos\(ctx\)\.filter\(x=>x\.id!==item\.id\)/);
  assert.doesNotMatch(html,/firebase-storage\.js/);
});

test('notification server integrates durable inbox and closed-site push',()=>{
  const edge=fs.readFileSync(path.join(home,'supabase/functions/kapani-push/index.ts'),'utf8');
  const sw=fs.readFileSync(path.join(home,'firebase-messaging-sw.js'),'utf8');
  assert.match(edge,/kp_tree_push_notification/);
  assert.match(edge,/sendNotification\(/);
  assert.match(edge,/getUser\(token\)/);
  assert.match(sw,/addEventListener\('push'/);
  assert.match(sw,/registration\.showNotification/);
});

test('Supabase path adapter creates firebase-compatible keys and query snapshots',async()=>{
  const data={chat:{x:{createdAt:1,nick:'ann'},y:{createdAt:2,nick:'bob'},z:{createdAt:3,nick:'ann'}}};
  const revisions={chat:0};
  const client={
    rpc:async(_name,{p_operation,p_path,p_payload,p_expected_revision})=>{
      const parts=p_path.split('/').filter(Boolean),root=parts[0],keys=parts.slice(1);
      if(!root)return {data:{value:data,revision:0}};
      const rev=revisions[root]||0;
      let value=data[root];for(const key of keys)value=value?.[key];
      if(p_operation==='read')return {data:{value:value??null,revision:rev}};
      if(p_expected_revision!==null && rev!==p_expected_revision)return {data:{conflict:true,revision:rev}};
      let pointer=data;for(const key of parts.slice(0,-1))pointer=pointer[key]??=(Object.create(null));
      if(p_operation==='set')pointer[parts.at(-1)]=p_payload;
      if(p_operation==='remove')delete pointer[parts.at(-1)];
      if(p_operation==='update')Object.assign(pointer[parts.at(-1)],p_payload);
      revisions[root]=rev+1;
      return {data:{committed:true,revision:rev+1}};
    },
    channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:()=>{},
    auth:{getSession:async()=>({data:{session:null}})}
  };
  const context={globalThis:{KAPANI_CONFIG:{supabase:{url:'https://example.supabase.co',anonKey:'sb_publishable_test'}}},
    createClient:()=>client,crypto:webcrypto,TextEncoder,structuredClone,queueMicrotask,console,Math,Date};
  context.globalThis.globalThis=context.globalThis;
  const source=bridge.replace(/^import .*;$/m,'').replaceAll('export ','');
  const exposed=vm.runInNewContext(`${source}\n({db,ref,get,set,push,runTransaction,query,orderByChild,equalTo,limitToLast})`,context);
  const root=exposed.ref(exposed.db,'chat');
  const sorted=await exposed.get(exposed.query(root,exposed.orderByChild('nick'),exposed.equalTo('ann'),exposed.limitToLast(1)));
  assert.deepEqual(Object.keys(sorted.val()),['z']);
  const item=await exposed.push(root,{nick:'c',createdAt:4});
  assert.match(item.key,/^-[a-z0-9]+$/);
  assert.equal((await exposed.get(item)).val().nick,'c');
  const transaction=await exposed.runTransaction(item,v=>({...v,nick:'updated'}));
  assert.equal(transaction.committed,true);
  assert.equal((await exposed.get(item)).val().nick,'updated');
});
