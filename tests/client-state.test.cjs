const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base=path.resolve(__dirname,'..');
function database(records=new Map()){
 return {records,transaction(){let pending=0,ended=false;const tx={};
 const schedule=fn=>{pending++;setImmediate(()=>{try{fn();}catch(e){tx.error=e;tx.onabort?.();}pending--;if(!pending&&!ended){ended=true;tx.oncomplete?.();}});};
 const store={get(id){const r={};schedule(()=>{r.result=records.get(id);r.onsuccess?.();});return r;},put(value){records.set(value.id,structuredClone(value));},delete(id){schedule(()=>records.delete(id));},openCursor(){const r={};let entries,i=0;const step=()=>schedule(()=>{entries ||= [...records.entries()];const item=entries[i++];r.result=item?{value:item[1],delete:()=>records.delete(item[0]),continue:step}:null;r.onsuccess?.();});step();return r;}};
 tx.objectStore=()=>store;return tx;}};
}
function sw(db){const shown=[];let fail=false;const c=vm.createContext({console,URL,Date,Promise,indexedDB:{},self:{location:{origin:'https://site.test'},registration:{showNotification:async(title,opts)=>{if(fail)throw Error('display failure');shown.push({title,opts});}},addEventListener(){}}});
 vm.runInContext(fs.readFileSync(path.join(base,'firebase-messaging-sw.js'),'utf8'),c);c.testDB=db;vm.runInContext('pushDatabase=async()=>testDB',c);
 return {show:data=>c.showKapaniPush(data),shown,fail:()=>{fail=true;}};
}
const payload={notificationId:'chat_msg123',recipientNick:'B',title:'Kapani',body:'hello'};
test('SW persists dedupe across VM restart',async()=>{const db=database(),first=sw(db);assert.equal(await first.show(payload),true);const second=sw(db);assert.equal(await second.show(payload),false);assert.equal(second.shown.length,0);});
test('concurrent foreground and push show one notification',async()=>{const a=sw(database());await Promise.all([a.show(payload),a.show(payload)]);assert.equal(a.shown.length,1);});
test('SW failed display removes reservation so a later push can retry',async()=>{const db=database(),a=sw(db);a.fail();await assert.rejects(a.show(payload));const b=sw(db);assert.equal(await b.show(payload),true);});
test('same event on another account is independent',async()=>{const a=sw(database());await a.show(payload);await a.show({...payload,recipientNick:'C'});assert.equal(a.shown.length,2);});
test('dedupe TTL lasts seven days, old entries expire',async()=>{const db=database();db.records.set('B:chat_msg123',{id:'B:chat_msg123',timestamp:Date.now()-8*86400000});const a=sw(db);assert.equal(await a.show(payload),true);assert.ok(Date.now()-db.records.get('B:chat_msg123').timestamp<1000);});
function locationHarness(){
 const html=fs.readFileSync(path.join(base,'index.html'),'utf8'),a=html.indexOf('function coordinate(value)'),b=html.indexOf('async function initBusinessDetailLocationMap',a),elements={};
 for(const id of ['mktLat','mktLng','mktAddress','mktLocationPreview','bapLat','bapLng','bapAddress','bapLocationPreview','deliveryOrderLat','deliveryOrderLng','deliveryOrderAddr','deliveryLocationPreview'])elements[id]={value:'',style:{}};
 for(const id of ['marketLocationPicker','bizLocationPicker','deliveryLocationPicker']){const btn={dataset:{},addEventListener(_event,cb){this.callback=cb;}};elements[id]={style:{},querySelector:()=>btn};elements[id+'Map']={};elements[id+'Coords']={};}
 const c=vm.createContext({console,Number,String,Promise,qs:id=>elements[id],document:{},requestAnimationFrame:fn=>fn(),BUSINESS_DEFAULT_LAT:52.6,BUSINESS_DEFAULT_LNG:38.4,toast(){},updateDeliverySummary(){},renderBusinessDeliveryMap:async()=>{},addSatelliteLayer(){},L:{map:()=>({on(){},remove(){}}),marker:coords=>{let ll={lat:coords[0],lng:coords[1]};return {addTo(){return this;},getLatLng:()=>ll,setLatLng:x=>{ll=x;},on(){}};}}});vm.runInContext('window=globalThis;window.kapaniLoadLeaflet=async()=>{}',c);vm.runInContext(html.slice(a,b),c);return {c,elements};
}
test('empty coordinate is invalid; real zero coordinates are valid',()=>{const {c}=locationHarness();assert.equal(c.locationPoint('','','fake'),null);assert.equal(c.locationPoint(null,undefined,'fake'),null);assert.equal(c.locationPoint(91,38,'fake'),null);assert.equal(c.locationPoint(0,0,'Equator').lat,0);});
test('map pickers retain independent marker state and save actual coordinates',async()=>{const {c,elements}=locationHarness();await c.openMarketLocationPicker();c.marketLocationPickerMarkerInstance.setLatLng({lat:52.61,lng:38.41}); // map click normally updates the modal state
 elements.marketLocationPicker._locationState={lat:52.61,lng:38.41};c.saveMarketLocationPicker();assert.equal(Number(elements.mktLat.value),52.61);
 await c.openBusinessLocationPicker('create');c.bizLocationPickerMarkerInstance.setLatLng({lat:52.62,lng:38.42});await c.saveBusinessLocationPicker();assert.equal(Number(elements.bapLat.value),52.62);assert.equal(Number(elements.mktLat.value),52.61);
 await c.openDeliveryLocationPicker();assert.equal(elements.deliveryOrderLat.value,'');elements.deliveryLocationPicker._locationState={lat:52.63,lng:38.43};c.saveDeliveryLocationPicker();assert.equal(Number(elements.deliveryOrderLat.value),52.63);assert.ok(elements.deliveryOrderAddr.value);});
