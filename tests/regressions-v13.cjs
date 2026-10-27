// Local behavior regressions with no network and no live database writes.
// SQL authorization/transactions still require owner-side Supabase testing.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const path=require('node:path');
const main=fs.readFileSync(path.join(__dirname,'../assets/kapani-main-classic.js'),'utf8');

function extract(start,end){
  const a=main.indexOf(start),b=main.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`cannot extract ${start}`);
  return main.slice(a,b);
}

const latest=vm.runInNewContext(extract('function latestMessageFrom(messages){','async function refreshDmPreviewsFromMessages')+'\nlatestMessageFrom');
const records={first:{createdAt:100,text:'Привет',nick:'Кайон2'},removed:{createdAt:250,msgType:'image',nick:'Кайон'}};
assert.equal(latest(records).msgType,'image');
delete records.removed;
assert.equal(latest(records).text,'Привет','after deleting a photo, older real message wins');
assert.equal(latest({}),null,'empty conversation has no ghost preview');

const preview=vm.runInNewContext(`
const currentNick='Кайон';
const allUsersCache={'Кайон2':{nick:'Кайон2'}};
function displayNick(u){return u?.nick;}
${extract('function dmPreviewText(msg){','function latestMessageFrom(messages){')}
dmPreviewText`);
assert.equal(preview({nick:'Кайон2',text:'Привет'}),'Кайон2: Привет');
assert.equal(preview({nick:'Кайон',attachments:[{type:'image',url:'https://example.com/image.jpg'}],text:''}),'Вы: Фото');
assert.equal(preview(null),'Новый чат');

const cancellation=vm.runInNewContext(`
let kapaniActiveMediaUpload={fromMessenger:true,cancel:()=>{globalThis.cancelled++}};
let hidden=0;
function hideMediaProgress(){hidden++}
${extract('function cancelMediaUpload(', 'function mediaProgressUI(')}
({ cancelMediaUpload, getHidden:()=>hidden })`,{cancelled:0});
cancellation.cancelMediaUpload('closing chat',true);
assert.equal(cancellation.getHidden(),1,'closing a messenger removes progress badge');

console.log('OK: deleted photo fallback, attachment previews and cancellation behavior.');
