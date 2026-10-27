'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=fs.readFileSync(path.join(root,'assets/kapani-auth.css'),'utf8');
const main=fs.readFileSync(path.join(root,'assets/kapani-main-classic.js'),'utf8');
const edge=fs.readFileSync(path.join(root,'supabase/functions/kapani-push/index.ts'),'utf8');

test('login and registration have separate controls with no legacy email or hints',()=>{
  assert.match(html,/id="authTabLogin"[^>]*>Вход<\/button>/);
  assert.match(html,/id="authTabRegister"[^>]*>Регистрация<\/button>/);
  assert.match(html,/id="lgNick"[^>]*placeholder="Ник"/);
  assert.match(html,/id="lgPass" type="password"/);
  assert.match(html,/id="lgInviterWrap"[^>]*hidden/);
  assert.doesNotMatch(html,/id="lgLegacyEmail"|Почта старого аккаунта|Старый аккаунт, например|создастся автоматически/);
  assert.match(main,/if\(mode === 'register'\)/);
  assert.match(main,/if\(!existing\) throw new Error\('Аккаунт с таким ником не найден'\)/);
  assert.match(main,/if\(existing\) throw new Error\('Этот ник уже занят'\)/);
});

test('four real slideshow photos and responsive centered auth styles exist',()=>{
  assert.match(html,/assets\/kapani-auth\.css\?v=1/);
  for(const name of ['forest-road','kapani-slide-dawn','kapani-slide-lake','kapani-slide-village']){
    assert.match(css,new RegExp(`${name}\\.webp`));
    assert.ok(fs.statSync(path.join(root,'assets',name+'.webp')).size>10000);
  }
  assert.match(css,/body:has\(#authSection\.active:not/);
  assert.match(css,/justify-content: center/);
  assert.match(css,/@media \(max-width: 750px\)/);
  assert.match(css,/@media \(max-width: 390px\)/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)/);
});

test('register tab reveals inviter, login hides it; password eye animates and resets',()=>{
  const makeClass=()=>{
    const values=new Set();
    return {toggle:(name,on)=>on?values.add(name):values.delete(name),add:name=>values.add(name),remove:name=>values.delete(name),contains:name=>values.has(name)};
  };
  const el=()=>({classList:makeClass(),attrs:{},setAttribute(k,v){this.attrs[k]=v;}});
  const label={textContent:'Войти'};
  const nodes={
    authTabLogin:el(),authTabRegister:el(),lgInviterWrap:{hidden:true},
    lgPass:{value:'secret',type:'password',autocomplete:'current-password'},
    authPasswordToggle:el(), authBtn:{disabled:false,querySelector:()=>label}
  };
  const card={dataset:{authMode:'login'}};
  const start=main.indexOf('window.setAuthMode = function(mode){');
  const end=main.indexOf('window.handleAuth = async function()',start);
  assert.ok(start>0&&end>start);
  const eyeStart=main.indexOf('window.toggleAuthPasswordVisibility = function(){');
  const eyeEnd=main.indexOf('async function findUserByPublicName',eyeStart);
  const context={window:{},document:{querySelector:()=>card},qs:id=>nodes[id]};
  vm.runInNewContext(main.slice(start,end)+'\n'+main.slice(eyeStart,eyeEnd),context);
  context.window.setAuthMode('register');
  assert.equal(card.dataset.authMode,'register');
  assert.equal(nodes.lgInviterWrap.hidden,false);
  assert.equal(nodes.lgPass.autocomplete,'new-password');
  assert.equal(label.textContent,'Создать аккаунт');
  context.window.toggleAuthPasswordVisibility();
  assert.equal(nodes.lgPass.type,'text');
  assert.equal(nodes.authPasswordToggle.attrs['aria-pressed'],'true');
  context.window.setAuthMode('login');
  assert.equal(nodes.lgInviterWrap.hidden,true);
  assert.equal(nodes.lgPass.type,'password');
  assert.equal(nodes.lgPass.value,'');
  assert.equal(label.textContent,'Войти');
});

test('nickname legacy login is private and never returns account email',()=>{
  const fn=edge.slice(edge.indexOf('async function loginByNickname('),edge.indexOf('async function sendTo('));
  assert.match(fn,/admin\.auth\.admin\.getUserById/);
  assert.match(fn,/grant_type=password/);
  assert.match(fn,/tokens\.user\?\.id !== profile\.user_id/);
  assert.match(fn,/access_token:tokens\.access_token,refresh_token:tokens\.refresh_token/);
  assert.doesNotMatch(fn,/json\(\{[^}]*email:/);
  assert.match(main,/supabase\.auth\.setSession/);
});
