// Offline regression checks for Kapani v15. No production network or money operations.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const html=read('index.html');
const main=read('assets/kapani-main-classic.js');
const sql=read('supabase/019_news_photo_albums.sql');
const installer=read('INSTALL.sql');

assert.match(html,/id="newsImageFile"[^>]+multiple/);
assert.match(html,/id="newsContent"[^>]+maxlength="10000"/);
assert.match(main,/window\.removeNewsImage=i=>/);
assert.match(main,/window\.removeNewsImageUrl=/);
assert.match(main,/if\(newsImageUploadBusy\)throw new Error/);
assert.match(main,/rpc\('kp_news_publish_v15'/);
assert.match(main,/function newsGalleryHtml\(/);
assert.match(sql,/jsonb_array_length\(images\) > 8/);
assert.match(sql,/kp_news_v10\('publish',p_news_id,null,p_data\)/);
assert.match(sql,/grant execute on function public\.kp_news_publish_v15/);
assert.ok(installer.replace(/\r\n/g,'\n').includes(sql.trim()),'the standalone news migration must be in INSTALL.sql');

assert.match(main,/Название объявления должно содержать от 2 до 120 символов/);
assert.match(main,/Описание объявления слишком длинное/);
assert.match(main,/Название бизнеса должно содержать от 2 до 80 символов/);
assert.match(main,/Описание бизнеса должно содержать от 5 до 2000 символов/);
assert.match(main,/patchOwnProfile\(\{settings\}\)/);
assert.doesNotMatch(main,/update\(userRef\(currentNick\), \{ pinnedChats: cur \}\)/);
assert.match(main,/qs\('jAppText'\)\.disabled=false;\s*if\(qs\('jAppText'\)\.value===\(myApp\.appText/);

for(const section of ['Taxi','Delivery','Janitor'])assert.match(html,new RegExp(`id="worker${section}Card"`));
assert.match(main,/const isDriver=curPage==='driverPage'/);
assert.match(main,/o\.worker===currentNick&&o\.type===type/);

const start=main.indexOf('async function renderHomeWorker(orders){');
const end=main.indexOf('// ─── WORKER PAGES',start);
assert.ok(start>=0&&end>start);
const els=Object.fromEntries(['workerTaxiList','workerDeliveryList','workerJanitorList'].map(id=>[id,{innerHTML:''}]));
const u={jobs:['Водитель','Доставщик']};
const ctx={
  qs:id=>els[id]||null,
  get:async()=>({exists:()=>true,val:()=>u}),
  userRef:n=>n,currentNick:'tester',
  hasMunicipalJob:(user,job)=>user.jobs.includes(job),
  JOB_JANITOR:'Уборщик',
  DRIVER_ACTIVE_ORDER_STATUSES:new Set(['accepted','driver_arriving','in_progress']),
  escHtml:value=>String(value),
};
vm.createContext(ctx);
vm.runInContext(main.slice(start,end),ctx);
(async()=>{
  await ctx.renderHomeWorker({
    taxiA:{type:'taxi',status:'pending',info:'Такси, улица Сосновая',client:'alice',price:200},
    deliveryA:{type:'shop',status:'waiting',info:'Посылка из магазина',client:'bob',price:75}
  });
  assert.match(els.workerTaxiList.innerHTML,/Такси, улица Сосновая/);
  assert.doesNotMatch(els.workerTaxiList.innerHTML,/Посылка из магазина/);
  assert.match(els.workerDeliveryList.innerHTML,/Посылка из магазина/);
  assert.doesNotMatch(els.workerDeliveryList.innerHTML,/Такси, улица Сосновая/);
  console.log('OK: v15 news albums, input validation, secured chat pin, job reapply, and dual worker queues.');
})().catch(e=>{console.error(e);process.exitCode=1;});
