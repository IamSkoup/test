'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'supabase/004_verified_money_and_mayor.sql'),'utf8');
const main=fs.readFileSync(path.join(root,'assets/kapani-main-classic.js'),'utf8');
const pack=fs.readFileSync(path.join(root,'assets/kapani-pack-classic.js'),'utf8');

test('sensitive RPCs restrict access by authenticated profile',()=>{
  for(const name of ['kp_mayor_adjust_balance','kp_mayor_fine','kp_bank_transfer',
    'kp_savings_move','kp_mayor_update_resident','kp_license_status',
    'kp_referral_summary','kp_mayor_clear_referrals','kp_mayor_queue',
    'kp_mayor_review_queue','kp_claim_migrated_once']){
    assert.match(sql,new RegExp(`create or replace function public\\.${name}\\(`));
    assert.match(sql,new RegExp(`revoke all on function public\\.${name}\\(`));
    assert.match(sql,new RegExp(`grant execute on function public\\.${name}\\(`));
  }
  assert.match(sql,/actor is distinct from 'Кайон'/);
  assert.match(sql,/select nickname into actor from public\.kp_profiles where user_id=auth\.uid\(\)/);
});

test('money-changing RPCs ignore caller-selected commission and guard replay',()=>{
  assert.match(sql,/rate:=case when sender_prime then 0\.01 else 0\.02 end/);
  assert.match(sql,/if sender_balance<total then raise exception/);
  assert.match(sql,/operation_id=p_request_id/);
  assert.match(sql,/md5\(p_request_id::text\|\|':recipient'\)/);
  assert.match(sql,/Balance outside permitted range/);
  assert.match(sql,/if savings<p_amount then raise exception/);
});

test('frontend invokes RPCs instead of attempting insecure writes on tested flows',()=>{
  for(const name of ['kp_mayor_adjust_balance','kp_bank_transfer','kp_savings_move',
    'kp_mayor_update_resident','kp_referral_summary','kp_mayor_queue',
    'kp_mayor_review_queue','kp_claim_migrated_once']){
    assert.ok(main.includes(`'${name}'`),`Frontend missing ${name}`);
  }
  assert.ok(pack.includes("'kp_license_status'"));
  assert.ok(pack.includes("'kp_mayor_update_resident'"));
  const fn=main.slice(main.indexOf('window.adminMoney='),main.indexOf('let _adminFineBusy'));
  assert.doesNotMatch(fn,/runTransaction\(/);
  assert.doesNotMatch(fn,/update\(userRef\(target\)/);
});
