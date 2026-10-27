const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('homepage services use three different real forest images',()=>{
  const css=read('assets/kapani-forest.css');
  for(const file of ['shop-forest.webp','taxi-forest.webp','delivery-forest.webp']){
    assert.match(css,new RegExp(file));
    const bytes=fs.readFileSync(path.join(root,'assets',file));
    assert.ok(bytes.length>10000);
    assert.equal(bytes.toString('ascii',0,4),'RIFF');
  }
});

test('dispatch and village info UI match requirements',()=>{
  const html=read('index.html');
  const css=read('assets/kapani-forest-finishes.css');
  const main=read('assets/kapani-main-classic.js');
  assert.match(html,/<option value="medical">Скорая помощь<\/option>/);
  assert.match(html,/id="medicalCalls"/);
  assert.match(html,/оплатить экзамен за 1 500 ₽ и успешно его сдать/);
  assert.doesNotMatch(html,/id="infoTab_money"|id="infoTabBtn_money"/);
  assert.match(css,/#callModal \.kapani-forest-dialog/);
  assert.match(css,/#infoModal \.kapani-forest-dialog/);
  assert.match(main,/rpc\('kp_dispatch_create'/);
  assert.match(main,/rpc\('kp_dispatch_close'/);
  assert.match(main,/rpc\('kp_dispatch_list'/);
  assert.match(main,/rpc\('kp_dispatch_recipients'/);
  assert.doesNotMatch(main,/push\(ref\(db,'calls'\)/);
  assert.doesNotMatch(main,/update\(ref\(db,`calls\//);
});

test('SQL requires server authority for balance and service-specific calls',()=>{
  const sql=read('supabase/007_duty_fines_and_emergency_calls.sql');
  for(const proc of ['kp_duty_fine','kp_dispatch_create','kp_dispatch_close','kp_dispatch_list','kp_dispatch_recipients']){
    assert.match(sql,new RegExp(`create or replace function public\\.${proc}\\(`));
  }
  assert.match(sql,/public\.kp_dispatch_role_allowed\('security',actor_profile\)/);
  assert.match(sql,/and not public\.kp_dispatch_role_allowed\(p_kind,user_doc\)/);
  assert.match(sql,/user_id=target_uid for update/);
  assert.match(sql,/operation_id=p_request_id/);
  assert.match(sql,/update public\.kp_wallets set balance=new_balance/);
  assert.match(sql,/insert into public\.kp_ledger/);
  assert.match(sql,/grant execute on function public\.kp_duty_fine.*to authenticated;/);
});

function fineHarness(){
  const src=read('assets/kapani-pack-classic.js');
  const start=src.indexOf('  let _submitDutyFineBusy = false;');
  const end=src.indexOf('  // Старые кнопки',start);
  assert.ok(start>=0&&end>start);
  const elements={dutyFineNick:{value:'Лёха'},dutyFineReason:{value:'Превышение скорости'},
    dutyFineAmt:{value:'500'},dutyFineSubmitBtn:{disabled:false,textContent:'Выписать штраф'}};
  const calls=[],toasts=[];
  let failNext=false,issuedId=0;
  const c=vm.createContext({
    window:{_getCurrentNick:()=> 'Сотрудник',kapaniSupabase:{rpc:async(name,args)=>{
      calls.push({name,args});return failNext?{error:{message:'network timeout'}}:{data:{ok:true}};
    }}},
    qs:id=>elements[id],get:async()=>({val:()=>({'Лёха':{displayName:'Лёха'},'Сотрудник':{}})}),
    db:{},ref:(_db,key)=>key,toast:(msg,type)=>toasts.push([msg,type]),
    pushNotification:async()=>({ok:true}),ADMIN:'Кайон',console,
    crypto:{randomUUID:()=>`00000000-0000-4000-8000-${String(++issuedId).padStart(12,'0')}`}
  });
  vm.runInContext(src.slice(start,end),c);
  return{ctx:c,elements,calls,toasts,setFail:v=>{failNext=v;}};
}

test('fine submits a server RPC, never a write to another user, and unlocks button',async()=>{
  const h=fineHarness();
  await h.ctx.window.submitDutyFine();
  assert.equal(h.calls.length,1);
  assert.equal(h.calls[0].name,'kp_duty_fine');
  assert.equal(h.calls[0].args.p_target,'Лёха');
  assert.equal(h.calls[0].args.p_amount,500);
  assert.equal(h.elements.dutyFineSubmitBtn.disabled,false);
  assert.equal(h.elements.dutyFineNick.value,'');
});

test('retry after connection failure retains the same idempotency ID',async()=>{
  const h=fineHarness();h.setFail(true);
  await h.ctx.window.submitDutyFine();
  assert.equal(h.elements.dutyFineSubmitBtn.disabled,false);
  h.setFail(false);
  await h.ctx.window.submitDutyFine();
  assert.equal(h.calls.length,2);
  assert.equal(h.calls[0].args.p_request_id,h.calls[1].args.p_request_id);
});
