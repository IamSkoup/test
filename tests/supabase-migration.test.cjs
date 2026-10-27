'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');

const home=path.resolve(__dirname,'..');
const documentHtml=fs.readFileSync(path.join(home,'index.html'),'utf8');
// Main entry points are deferred classic scripts so local file:// opens work.
const html=[documentHtml,'assets/kapani-main-classic.js','assets/kapani-pack-classic.js']
  .map((source,i)=>i?fs.readFileSync(path.join(home,source),'utf8'):source).join('\n');
const bridge=fs.readFileSync(path.join(home,'supabase-bridge.js'),'utf8');
const migration=fs.readFileSync(path.join(home,'supabase/001_tree_bridge.sql'),'utf8');
const accountFixes=fs.readFileSync(path.join(home,'supabase/002_account_and_tasks.sql'),'utf8');

test('the site uses Supabase as the only active client data provider',()=>{
  assert.match(documentHtml,/src="\.\/assets\/supabase-bridge-classic\.js" defer/);
  assert.match(documentHtml,/src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2\.49\.8" defer/);
  assert.doesNotMatch(html,/from ["']https:\/\/www\.gstatic\.com\/firebasejs/);
  assert.match(bridge,/kp_tree_access/);
  assert.match(migration,/enable row level security/i);
  assert.match(migration,/Protected account field/);
  assert.match(migration,/kp_public_profiles\(\)/);
  assert.match(html,/supabase\.rpc\('kp_public_profiles'\)/);
});

test('legacy clients cannot directly mint currency or assign privileged roles',()=>{
  assert.match(migration,/Replacing an entire user record is forbidden/);
  assert.match(migration,/Protected operation: a dedicated server function is required/);
  assert.match(migration,/subtree\[2\] <> all\(allowed_profile_fields\)/);
  assert.match(migration,/subtree\[1\] <> actor_nick/);
  assert.match(migration,/Not a DM participant/);
  assert.match(migration,/kp_consume_notify_quota/);
  assert.match(migration,/kp_push_events/);
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

test('notification removal cannot modify another inbox or fabricate notifications',()=>{
  assert.match(html,/manageOwnNotifications\('delete',String\(notifId\)\)/);
  assert.match(html,/manageOwnNotifications\('clear'\)/);
  assert.doesNotMatch(html,/window\.clearAllNotifications=async function\(\)\{await remove\(/);
  assert.match(accountFixes,/auth\.uid\(\)/);
  assert.match(accountFixes,/public\.kp_profiles where user_id=auth\.uid\(\)/);
  assert.match(accountFixes,/whole #- array\[nick,'notifications',p_notification_id\]/);
  assert.match(accountFixes,/grant execute on function public\.kp_manage_notifications\(text,text\) to authenticated/);
});

test('profile editing and password changes use authenticated, narrowly scoped services',()=>{
  assert.match(bridge,/kp_profile_patch/);
  assert.match(accountFixes,/Protected account field: %/);
  assert.match(accountFixes,/not \(k=any\(editable\)\)/);
  const editable=(/editable constant text\[\]:=array\[([\s\S]*?)\];/.exec(accountFixes)||[])[1]||'';
  assert.ok(editable.includes("'avatar'"));
  assert.ok(!editable.includes("'balance'"));
  assert.match(html,/supabase\.auth\.updateUser\(\{password:next\}\)/);
  assert.doesNotMatch(html,/set\(userRef\(targetNick\), migrated\)/);
  assert.match(html,/avatarSrc = u\.avatar \|\| u\.avatarUrl \|\| u\.photoURL \|\| DEFAULT_AVATAR_URL/);
});

test('nickname login needs no email and only reconstructs the authenticated owners missing profile',()=>{
  assert.doesNotMatch(documentHtml,/id="lgLegacyEmail"/);
  assert.match(html,/establishKapaniServerSession\(existing\.nick, password\)/);
  assert.match(html,/email:normalizedEmail\|\|await authEmail\(expectedNick\)/);
  assert.match(html,/supabase\.rpc\('kp_ensure_my_profile'\)/);
  assert.match(html,/kapaniVerifiedIdentity\?\.id===signedUser\.id/);
  assert.doesNotMatch(html,/data\.user\.user_metadata\?\.nick\|\|currentNick/);
  assert.match(html,/email:identity\.user\.email,password:cur/);
  assert.match(accountFixes,/create or replace function public\.kp_ensure_my_profile\(\)/);
  assert.match(accountFixes,/select nickname into nick from public\.kp_profiles where user_id=auth\.uid\(\)/);
  assert.match(accountFixes,/if whole \? nick then/);
  assert.match(accountFixes,/select balance into wallet_balance from public\.kp_wallets where user_id=auth\.uid\(\)/);
  assert.match(accountFixes,/grant execute on function public\.kp_ensure_my_profile\(\) to authenticated/);
  assert.match(accountFixes,/revoke all on function public\.kp_ensure_my_profile\(\) from public,anon/);
});

test('task rewards and cash-outs never accept a client-set balance',()=>{
  assert.match(html,/claimVerifiedTask\(kind,id\)/);
  assert.match(html,/withdrawVerifiedTasks\(amount\)/);
  assert.match(accountFixes,/create or replace function public\.kp_claim_task/);
  assert.match(accountFixes,/create or replace function public\.kp_withdraw_tasks/);
  assert.match(accountFixes,/for update/);
  assert.match(accountFixes,/update public\.kp_wallets set balance=balance\+p_amount/);
  assert.match(accountFixes,/insert into public\.kp_ledger/);
  assert.doesNotMatch(accountFixes,/reward:=p_/);
});

test('file protocol loads ordered classic scripts without requiring a local server',()=>{
  assert.match(documentHtml,/location\.protocol === 'file:'/);
  assert.match(documentHtml,/src="\.\/assets\/kapani-main-classic\.js" defer/);
  assert.match(documentHtml,/src="\.\/assets\/kapani-pack-classic\.js" defer/);
  assert.match(documentHtml,/src="\.\/assets\/kapani-season-classic\.js" defer/);
  assert.doesNotMatch(documentHtml,/<script type="module"/);
  assert.doesNotMatch(documentHtml,/Сайт запущен неправильно/);
  assert.match(fs.readFileSync(path.join(home,'start-kapani.bat'),'utf8'),/python -m http\.server 8765/);
});

test('privileged actions call server functions, not direct user or treasury mutations',()=>{
  const app=fs.readFileSync(path.join(home,'assets/kapani-main-classic.js'),'utf8');
  const pack=fs.readFileSync(path.join(home,'assets/kapani-pack-classic.js'),'utf8');
  const protectedSql=fs.readFileSync(path.join(home,'supabase/003_protected_app_operations.sql'),'utf8');
  assert.match(app,/supabase\.rpc\('kp_process_economy_charges'\)/);
  assert.match(app,/supabase\.rpc\('kp_verify_account'/);
  assert.match(app,/supabase\.rpc\('kp_municipal_treasury_withdraw'/);
  assert.match(documentHtml,/rpc\('kp_municipal_treasury_snapshot'\)/);
  assert.match(pack,/\.rpc\('kp_save_passport'/);
  assert.doesNotMatch(pack,/set\(ref\(db, `passports\/\$\{nick\}`\), payload\)/);
  assert.match(protectedSql,/auth\.uid\(\)/);
  assert.match(protectedSql,/where user_id=auth\.uid\(\)/);
  assert.match(protectedSql,/for update/);
});

test('client routes profile and notification changes through owner-only procedures',async()=>{
  const calls=[];
  const sessionUser={id:'user-1'};
  const client={
    rpc:async(name,args)=>{calls.push({name,args});return {data:{ok:true},error:null};},
    auth:{getUser:async()=>({data:{user:sessionUser},error:null})},
    from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{nickname:'Кайон'},error:null})}),
    channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:()=>{}
  };
  const context={globalThis:{KAPANI_CONFIG:{supabase:{url:'https://example.supabase.co',anonKey:'sb_publishable_test'}}},
    createClient:()=>client,crypto:webcrypto,TextEncoder,structuredClone,queueMicrotask,console,Math,Date};
  const source=bridge.replace(/^import .*;$/m,'').replaceAll('export ','');
  const sdk=vm.runInNewContext(`${source}\n({db,ref,update,manageOwnNotifications,claimVerifiedTask,withdrawVerifiedTasks})`,context);
  await sdk.update(sdk.ref(sdk.db,'users/Кайон'),{avatar:'https://cdn.example/avatar.webp'});
  await sdk.manageOwnNotifications('delete','n-123');
  await sdk.manageOwnNotifications('clear');
  await sdk.claimVerifiedTask('daily','chat');
  await sdk.withdrawVerifiedTasks(500);
  assert.deepEqual(calls.map(x=>x.name),[
    'kp_profile_patch','kp_manage_notifications','kp_manage_notifications','kp_claim_task','kp_withdraw_tasks'
  ]);
  assert.equal(calls[0].args.p_patch.avatar,'https://cdn.example/avatar.webp');
  assert.equal(calls[1].args.p_notification_id,'n-123');
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
