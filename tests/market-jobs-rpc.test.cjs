'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const sql=fs.readFileSync(path.join(root,'supabase/005_marketplace_and_employment.sql'),'utf8');
const main=fs.readFileSync(path.join(root,'assets/kapani-main-classic.js'),'utf8');
const pack=fs.readFileSync(path.join(root,'assets/kapani-pack-classic.js'),'utf8');

test('all marketplace and employment mutations use protected server RPCs',()=>{
  for(const fn of ['kp_market_action','kp_job_application','kp_rent_listing_action']){
    assert.match(sql,new RegExp(`create or replace function public\\.${fn}\\(`));
    assert.match(sql,new RegExp(`revoke all on function public\\.${fn}\\(`));
    assert.match(sql,new RegExp(`grant execute on function public\\.${fn}\\(`));
  }
  assert.match(main,/supabase\.rpc\('kp_market_action'/);
  assert.match(main,/supabase\.rpc\('kp_job_application'/);
  assert.match(pack,/kapaniSupabase\.rpc\('kp_rent_listing_action'/);
  const market=main.slice(main.indexOf('window.publishListing='),main.indexOf('// ─── LEADERBOARD'));
  assert.doesNotMatch(market,/await update\(userRef\(/);
  assert.doesNotMatch(market,/await set\(listingRef\(/);
  assert.doesNotMatch(market,/await update\(listingRef\(/);
  assert.doesNotMatch(market,/await remove\(listingRef\(/);
  const jobs=main.slice(main.indexOf('window.sendApp='),main.indexOf('// ─── PROFILE'));
  assert.doesNotMatch(jobs,/await set\(appRef\(/);
  assert.doesNotMatch(jobs,/await remove\(appRef\(/);
  const approvals=main.slice(main.indexOf('window.approveApp='),main.indexOf('let _adminMoneyBusy'));
  assert.doesNotMatch(approvals,/await update\(userRef\(/);
  assert.doesNotMatch(approvals,/await update\(appRef\(/);
});

test('server checks actor identity, limits, job grades and financial settlement',()=>{
  assert.match(sql,/select nickname into actor from public\.kp_profiles where user_id=auth\.uid\(\)/);
  assert.match(sql,/actor<>'Кайон'/);
  assert.match(sql,/if score<req then raise exception/);
  assert.match(sql,/if job_count>=max_jobs then raise exception/);
  assert.match(sql,/if used_count>=allowed_count then raise exception/);
  assert.match(sql,/if actor<>buyer or status_now<>'meeting_confirmed'/);
  assert.match(sql,/if buyer_balance<amount\+fee then raise exception/);
  assert.match(sql,/from public\.kp_wallets/);
  assert.match(sql,/insert into public\.kp_ledger/);
  assert.match(sql,/and l\.kind='market_purchase' and l\.amount<0/);
});

test('job eligibility check is read-only',()=>{
  const method=main.slice(main.indexOf('async function canTakeAnotherJob'),
    main.indexOf('function applyBizBgEffect'));
  assert.doesNotMatch(method,/syncUserEmployments/);
  assert.doesNotMatch(method,/await update\(/);
  assert.match(method,/countActiveEmployments/);
});

test('bank history reads authenticated ledger instead of obsolete user txlog',()=>{
  assert.match(sql,/create or replace function public\.kp_my_transactions\(\)/);
  assert.match(sql,/where l\.user_id=auth\.uid\(\)/);
  assert.match(sql,/grant execute on function public\.kp_my_transactions\(\) to authenticated/);
  assert.match(main,/supabase\.rpc\('kp_my_transactions'\)/);
  for(const name of ['renderRecentTransfers','renderFinancialStats','openHistoryModal']){
    const from=main.indexOf(name==='renderFinancialStats'?'window.renderFinancialStats=':
      name==='openHistoryModal'?'window.openHistoryModal=':'async function renderRecentTransfers()');
    const to=main.indexOf(name==='renderRecentTransfers'?'let _callPhotoData':
      name==='renderFinancialStats'?'function monthTitleRu':'window.closeHistoryModal=',from);
    const method=main.slice(from,to);
    assert.match(method,/getAccountTransactions\(\)/);
    assert.doesNotMatch(method,/get\(txLogRef\(currentNick\)\)/);
  }
});
