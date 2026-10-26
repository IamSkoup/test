'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'assets/kapani-ui.js'), 'utf8');
const forest = fs.readFileSync(path.join(root, 'assets/kapani-forest.css'), 'utf8');

test('forest style is loaded last and ships local photographic assets', () => {
  assert.ok(html.includes('assets/kapani-forest.css?v=1'));
  assert.ok(html.indexOf('assets/kapani-forest.css') > html.indexOf('assets/kapani-season-themes.css'));
  assert.ok(fs.statSync(path.join(root, 'assets/forest-road.webp')).size > 10000);
  assert.ok(fs.statSync(path.join(root, 'assets/village-street.webp')).size > 10000);
  assert.match(forest, /url\('\.\/forest-road\.webp'\)/);
});

test('loader has a fir-tree entrance, title entrance and motion-safe fallback', () => {
  assert.match(html, /<svg class="lo-pine"/);
  assert.match(html, /<div class="lo-title">Капани<\/div>/);
  assert.match(forest, /@keyframes loSprout/);
  assert.match(forest, /@keyframes loTitle/);
  assert.match(forest, /prefers-reduced-motion:reduce/);
  assert.match(html, /ov\.classList\.add\('lo-complete'\)/);
});

test('all original home actions remain reachable and mayor appearance tab is gone', () => {
  const actions = ['shop','taxi','deliveryOrderPage','jobs','ratings','hospital',
    'autoSchool','kveExam','kEducation','casino','events'];
  for (const id of actions) assert.ok(html.includes("navTo('" + id + "')"), id);
  assert.ok(!ui.includes("['appearance', 'Оформление'"));
  assert.match(html, /class="home-map-details"/);
  assert.match(ui, /Быстрые действия/);
});

function makeAbandonHarness(type, status) {
  const segment = html.match(/async function fallbackCancelOrder\(data\) \{[\s\S]*?\n\}\n\n\/\/ Fallback: Pay order directly/);
  assert.ok(segment, 'fallback cancellation function present');
  const source = segment[0].replace(/\n\n\/\/ Fallback: Pay order directly$/, '');
  const records = {
    order: {id:'ord1',client:'client',worker:'driver',type,status,price:250},
    user: {balance:100}
  };
  const logs = [];
  const snap = value => ({exists:()=>value!==null && value!==undefined,val:()=>value});
  const c = vm.createContext({
    currentNick:'driver',
    location:{protocol:'https:'},
    DRIVER_ACTIVE_ORDER_STATUSES:new Set(['accepted','driver_arriving','in_progress']),
    orderRef:()=> 'order',
    userRef:()=> 'user',
    get:async ref=>snap(records[ref]),
    runTransaction:async(ref,mutate)=>{
      const value=mutate(structuredClone(records[ref]));
      if(value===undefined)return {committed:false,snapshot:snap(records[ref])};
      records[ref]=value;
      return {committed:true,snapshot:snap(value)};
    },
    logTx:async (...args)=>logs.push(args),
    remove:async ref=>{records[ref]=null;},
    Date,Math,Number,Error,Promise
  });
  vm.runInContext(source, c);
  return {c,records,logs};
}

for (const status of ['accepted','driver_arriving','in_progress']) {
  test('taxi driver can abandon order in ' + status, async () => {
    const {c,records,logs}=makeAbandonHarness('taxi',status);
    const result=await c.fallbackCancelOrder({orderId:'ord1'});
    assert.equal(result.success,true);
    assert.equal(result.penalty,35);
    assert.equal(records.order.worker,null);
    assert.equal(records.order.status,'pending');
    assert.equal(records.user.balance,65);
    assert.equal(logs.length,1);
    await assert.rejects(c.fallbackCancelOrder({orderId:'ord1'}));
  });
}

test('delivery job returns to its queue, completed taxi cannot be abandoned', async () => {
  const shop=makeAbandonHarness('shop','in_progress');
  await shop.c.fallbackCancelOrder({orderId:'ord1'});
  assert.equal(shop.records.order.status,'waiting');
  const completed=makeAbandonHarness('taxi','waiting_payment');
  await assert.rejects(completed.c.fallbackCancelOrder({orderId:'ord1'}), /недоступен/);
});

test('client-facing driver action confirms once and survives notification failure', async () => {
  const start = html.indexOf('const _abandonPending = new Set();');
  const end = html.indexOf('// ─── LOCATION TRACKING', start);
  assert.ok(start>0 && end>start);
  const calls=[],toasts=[];
  const context = vm.createContext({
    window:{},
    currentNick:'driver',
    location:{protocol:'https:'},
    orderRef:()=> 'ord1',
    get:async()=>({exists:()=>true,val:()=>({
      client:'client',worker:'driver',type:'taxi',status:'accepted'
    })}),
    DRIVER_ACTIVE_ORDER_STATUSES:new Set(['accepted','driver_arriving','in_progress']),
    PUSH_WORKER_URL:'https://kapani-push.example',
    getPushAuthHash:async()=> 'fake-hash',
    pushWorkerCall:async(name,payload)=>{
      calls.push({name,payload}); return {success:true,penalty:35};
    },
    fallbackCancelOrder:async()=>{},
    pushNotification:async()=>{throw new Error('push unavailable');},
    toast:(message,kind)=>toasts.push({message,kind}),
    confirm:()=>true,
    navigator:{geolocation:{clearWatch(){}}},
    console:{error(){}},
    Set,Promise,Number,String,Math
  });
  vm.runInContext("let locationWatchId=null;let currentTrackOrderId='ord1';let _driverUiKey='old';",context);
  vm.runInContext(html.slice(start,end),context);
  await context.window.abandonOrder('ord1');
  assert.equal(calls.length,1);
  assert.equal(calls[0].name,'/abandon-order');
  assert.equal(calls[0].payload.nick,'driver');
  assert.equal(toasts[0].kind,'green');
});

for (const workerName of ['worker.js','worker-bundled.js']) test('Cloudflare '+workerName+' cancellation is authenticated and atomic', async () => {
  const workerCode = fs.readFileSync(path.join(root,'push-worker',workerName),'utf8');
  const start = workerCode.indexOf('async function handleAbandonOrder(');
  const end = workerCode.indexOf('async function handleGift(',start);
  assert.ok(start > 0 && end > start);
  assert.match(workerCode, /url\.pathname === '\/abandon-order'/);
  const database = {
    users: { driver: {balance:100}, intruder:{balance:70} },
    orders: {ord1: {worker:'driver',client:'client',status:'accepted',type:'taxi'}}
  };
  const context = vm.createContext({
    verifyUser:async(_env,nick,hash)=> hash === 'good' && ['driver','intruder'].includes(nick),
    giftIdPart:()=> 'tx-test',
    moscowTime:()=> '13:00',
    rtdbRootTransaction:async (_env, updater) => {
      const decision=await updater(structuredClone(database));
      if(!decision || decision.abort) return {committed:false,reason:decision?.reason};
      Object.assign(database, decision.value);
      return {committed:true};
    },
    json:(_request,_env,body,status=200)=> ({...body,status}),
    Date, String, Number, Math, Promise
  });
  vm.runInContext(workerCode.slice(start,end),context);
  const handle = context.handleAbandonOrder;
  const wrong = await handle({}, {}, {nick:'intruder',ph:'good',orderId:'ord1'});
  assert.equal(wrong.status,409);
  assert.equal(database.users.driver.balance,100);
  const unauthorized = await handle({}, {}, {nick:'driver',ph:'wrong',orderId:'ord1'});
  assert.equal(unauthorized.status,401);
  const result = await handle({}, {}, {nick:'driver',ph:'good',orderId:'ord1'});
  assert.equal(result.success,true);
  assert.equal(result.penalty,35);
  assert.equal(database.orders.ord1.status,'pending');
  assert.equal(database.orders.ord1.worker,null);
  assert.equal(database.users.driver.balance,65);
  assert.equal(database.users.driver.txlog['tx-test'].amt,35);
  const twice = await handle({}, {}, {nick:'driver',ph:'good',orderId:'ord1'});
  assert.equal(twice.status,409);
  assert.equal(database.users.driver.balance,65);
});

test('secured server cancellation uses the authenticated worker and frees the taxi', async () => {
  const backend = fs.readFileSync(path.join(root,'functions/index.js'),'utf8');
  const start = backend.indexOf('exports.abandonOrder = onCall(');
  const end = backend.indexOf('// Cloud Function для принятия заказа работником',start);
  assert.ok(start>0 && end>start);
  const database={
    'orders/ord1':{id:'ord1',type:'taxi',worker:'driver',client:'client',status:'driver_arriving'},
    'users/driver':{balance:50},
    'users/intruder':{balance:50}
  };
  const logs=[];
  const snap=value=>({exists:()=>!!value,val:()=>value});
  function ref(key) {
    return {
      get:async()=>snap(database[key]),
      transaction:async mutate=>{
        const next=mutate(structuredClone(database[key]));
        if(next===undefined) return {committed:false,snapshot:snap(database[key])};
        database[key]=next;
        return {committed:true,snapshot:snap(next)};
      },
      child:name=>({push:async record=>logs.push({key:key+'/'+name,record})})
    };
  }
  class HttpsError extends Error {
    constructor(code,message){super(message);this.code=code;}
  }
  const context=vm.createContext({
    exports:{},onCall:(_options,handler)=>handler,
    HttpsError,db:{ref},getDateTime:()=>({date:'today',time:'now',ts:1}),
    Promise,Date,Number,String,Math
  });
  vm.runInContext(backend.slice(start,end),context);
  const abandon=context.exports.abandonOrder;
  await assert.rejects(abandon({auth:{uid:'intruder'},data:{orderId:'ord1'}}),/другому исполнителю/);
  assert.equal(database['orders/ord1'].worker,'driver');
  const result=await abandon({auth:{uid:'driver'},data:{orderId:'ord1'}});
  assert.equal(result.success,true);
  assert.equal(result.penalty,35);
  assert.equal(database['orders/ord1'].status,'pending');
  assert.equal(database['orders/ord1'].worker,null);
  assert.equal(database['users/driver'].balance,15);
  assert.equal(logs.length,1);
  await assert.rejects(abandon({auth:{uid:'driver'},data:{orderId:'ord1'}}));
  assert.equal(database['users/driver'].balance,15,'repeat action must not double-charge');
});
