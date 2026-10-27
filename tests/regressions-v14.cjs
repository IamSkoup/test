// Regression assertions for revision 14; never connects to Supabase.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const js=read('assets/kapani-main-classic.js');
const css=read('assets/kapani-v14-fixes.css');
const html=read('index.html');
const sql=read('supabase/018_profile_savings_and_receipts.sql');

const customization=js.slice(js.indexOf('window.saveProfileCustomization=async'),js.indexOf('window.changeAvatarUrl=async'));
assert.match(customization,/supabase\.rpc\('kp_profile_customization_v14'/);
assert.doesNotMatch(customization,/update\(userRef\(currentNick\),\s*updates\)/);
assert.ok(customization.indexOf("if(!data?.ok)") < customization.indexOf("toast('Настройки оформления сохранены'"));
assert.match(sql,/select document,revision into whole,rev from public\.kp_tree_roots[\s\S]*?where branch='users' for update/);
assert.match(sql,/if greatest\(1,required_tier\)>tier then/);
assert.match(sql,/if tier<3 or coalesce\(profile->>'profileBgEffect',''\)<>'custom'/);
assert.match(css,/#profile #profileHeaderBg\.profile-header\[class\*="profile-bg-"\]/);
assert.ok(html.indexOf('kapani-v10.css') < html.indexOf('kapani-v14-fixes.css'));

assert.match(js,/src="\$\{escHtml\(safeAvatar\(m\.nick,m\.avatar\|\|DEFAULT_AVATAR_URL\)\)\}"/);
assert.match(css,/#dmMessages \.chat-av/);
assert.match(css,/#toasts \{\s*z-index:2147483643/);
assert.match(css,/#notifPopup \{\s*z-index:2147483644/);
assert.match(css,/#kpV8Sheet\.v8-overlay,[\s\S]*?backdrop-filter:none !important/);

assert.match(html,/class="kp-savings-summary"/);
assert.match(html,/Ставка: <span id="savingsRateDisplay">\+0,3% в день/);
assert.match(css,/#bank \.kp-savings-balance \{\s*min-width:125px/);
assert.match(js,/supabase\.rpc\('kp_savings_accrue_v14'\)/);
assert.match(sql,/per_day:=least\(1000000000-savings,floor\(due\)::bigint\)/);
assert.match(sql,/p_profile->>'savingsAccrualV14At'/);
assert.match(sql,/if exists\(select 1 from public\.kp_ledger where operation_id=p_request_id\)/);
assert.match(sql,/kind,details\)[\s\S]*?'savings_interest'/);
assert.match(sql,/for update/);

const receipt=js.slice(js.indexOf("window.doTransfer=()=>action('bank-transfer'"),js.indexOf('const bank=qs(\'bank\')'));
assert.ok(receipt.indexOf('await confirmTransferLedgerV14(id)')<receipt.indexOf("modal('Перевод выполнен'"));
assert.match(receipt,/if\(!journalRecord\)\{/);
assert.match(js,/rows\.find\(item=>String\(item\.id\)===String\(operationId\) && item\.type==='out'\)/);

// Independent arithmetic examples for the documented rate and carry behavior.
// PostgreSQL execution/concurrency still must be tested after owner migration.
function simulatedSavings(principal,days){let balance=principal,carry=0;
  for(let day=0;day<days;day++){
    const due=balance*.003+carry,credit=Math.floor(due);
    balance+=credit;carry=due-credit;
  }return {balance,carry};
}
assert.equal(simulatedSavings(1000,0).balance,1000);
assert.equal(simulatedSavings(1000,1).balance,1003);
assert.equal(simulatedSavings(1000,2).balance,1006);
assert.equal(simulatedSavings(100,3).balance,100);
assert.equal(simulatedSavings(100,4).balance,101);
console.log('OK: profile permissions, skins, avatars, notifications, confirmed receipts, and savings offline contracts.');
