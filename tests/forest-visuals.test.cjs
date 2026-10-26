'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')+'\n'+
  fs.readFileSync(path.join(root, 'assets/kapani-main-classic.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'assets/kapani-forest-finishes.css'), 'utf8');
const skins = ['forest_moss','forest_dusk','nature_meadow','nature_aurora','wild_ember','wild_storm'];

test('finishes load after earlier themes and retain all original effects', () => {
  assert.ok(html.indexOf('assets/kapani-forest-finishes.css') > html.indexOf('assets/kapani-forest.css'));
  assert.match(css, /\[class\*="profile-bg-"\]/);
  assert.match(css, /\.chat-msg\.me \.chat-bubble\[class\*="chat-bubble-"\]/);
  for (const old of ['gold','rainbow','ocean','sunset','aurora','galaxy','fire','neon','rose','plasma','thunder','hologram','dragon','prime']) {
    assert.match(css, new RegExp('\\.chat-bubble-' + old + '\\s*\\{'));
  }
});

test('each nature skin is registered for frame, wall, message and CSS', () => {
  const block = html.slice(html.indexOf('const AVATAR_FRAME_CLASSES'), html.indexOf('const PRICE_PER_KM'));
  const context = vm.createContext({Object,Date});
  vm.runInContext(block, context);
  for (const skin of skins) {
    assert.equal(vm.runInContext(`AVATAR_FRAME_CLASSES['${skin}']`,context), `avatar-frame-${skin.replaceAll('_','-')}`);
    assert.equal(vm.runInContext(`PROFILE_BG_CLASSES['${skin}']`,context), `profile-bg-${skin.replaceAll('_','-')}`);
    assert.equal(vm.runInContext(`CHAT_BUBBLE_CLASSES['${skin}']`,context), `chat-bubble-${skin.replaceAll('_','-')}`);
    for (const prefix of ['avatar-frame','profile-bg','chat-bubble']) {
      assert.ok(css.includes('.'+prefix+'-'+skin.replaceAll('_','-')), prefix+' '+skin);
    }
  }
  assert.equal(vm.runInContext(`getAvatarFrameClass({subscriptionExpiry:new Date(Date.now()+1000000).toISOString(), avatarFrame:'wild_storm'})`,context),'avatar-frame-wild-storm');
  assert.equal(vm.runInContext(`getAvatarFrameClass({subscriptionExpiry:'2020-01-01', avatarFrame:'wild_storm'})`,context),'');
});

test('customization offers only the forest / nature / wild skins unlocked by subscription', async () => {
  const source = html.slice(html.indexOf('window.openProfileCustomizer=async function(){'),html.indexOf('window.closeProfileCustomizer=async function(){'));
  for(const [plan,allowed,notAllowed] of [
    ['plus',['forest_moss','nature_meadow'],['forest_dusk','nature_aurora','wild_ember','wild_storm']],
    ['ultra',['forest_moss','nature_meadow','forest_dusk','nature_aurora','wild_ember'],['wild_storm']],
    ['prime',skins,[]]
  ]) {
    let markup='';
    const account={subscription:plan,subscriptionExpiry:new Date(Date.now()+86400000).toISOString()};
    const doc={createElement:()=>({innerHTML:'',id:''}),body:{appendChild:el=>{markup=el.innerHTML;}}};
    const ctx=vm.createContext({window:{},document:doc,get:async()=>({val:()=>account}),userRef:()=>'',currentNick:'test',setTimeout:()=>{},Date,validPrimeCoverData:()=>false});
    vm.runInContext(source,ctx);
    await ctx.window.openProfileCustomizer();
    for(const skin of allowed) assert.ok(markup.includes(`value="${skin}"`),plan+' should unlock '+skin);
    for(const skin of notAllowed) assert.ok(!markup.includes(`value="${skin}"`),plan+' should lock '+skin);
    assert.match(markup,/id="kapaniSkinPreview"/);
    assert.equal(markup.includes('value="custom"'),plan==='prime','only Prime can upload a custom profile cover');
  }
});

test('forest frames have transparent centers and four new forest covers load from local images', () => {
  const frames = css.slice(css.indexOf('/* The frame div is on top'),css.indexOf('html[data-season] .avatar-frame-prime'));
  assert.match(frames,/background:none !important/);
  assert.match(frames,/mask-composite:exclude/);
  assert.match(frames,/::before/);
  assert.doesNotMatch(frames,/linear-gradient\(transparent,transparent\) padding-box/);
  for(const [skin, filename] of [
    ['nature-meadow','forest-meadow.webp'],['nature-aurora','forest-aurora.webp'],
    ['wild-ember','forest-ember.webp'],['wild-storm','forest-storm.webp']
  ]){
    assert.match(css,new RegExp(`\\.profile-bg-${skin}\\s*\\{[^}]*${filename.replace('.','\\.')}`));
    assert.ok(fs.statSync(path.join(root,'assets',filename)).size > 20000);
  }
});

test('Prime covers have upload, save, visitor rendering, subscription description and scoped write rule', () => {
  assert.match(html, /id="primeCoverInput" type="file"/);
  assert.match(html, /window\.handlePrimeCoverSelection=async function/);
  assert.match(html, /updates\.profileCustomBg = primeCoverPending/);
  assert.match(html, /function getProfileBgClass\(user\)\{[\s\S]*user\?\.subscription !== 'prime'/);
  assert.ok((html.match(/applyPrimeCoverToElement\(/g)||[]).length >= 6);
  assert.match(html,/Свой фон профиля/);
  const rules = JSON.parse(fs.readFileSync(path.join(root,'database.rules.json'),'utf8'));
  assert.match(rules.rules.users['$uid'].profileCustomBg['.write'],/subscription/);
  assert.match(rules.rules.users['$uid'].profileCustomBg['.validate'],/image\/jpeg/);
});

test('custom Prime cover stays gated and is cleared when switching to a normal background', () => {
  const source = html.slice(html.indexOf('const AVATAR_FRAME_CLASSES'),html.indexOf('const PRICE_PER_KM'));
  const ctx = vm.createContext({Date});
  vm.runInContext(source,ctx);
  const cover = 'data:image/jpeg;base64,AAAA';
  assert.equal(vm.runInContext(`validPrimeCoverData('${cover}')`,ctx),true);
  assert.equal(vm.runInContext("validPrimeCoverData('javascript:alert(1)')",ctx),false);
  const expiry = new Date(Date.now()+86400000).toISOString();
  ctx.primeUser = {subscription:'prime',subscriptionExpiry:expiry,profileBgEffect:'custom'};
  ctx.ultraUser = {...ctx.primeUser,subscription:'ultra'};
  assert.equal(vm.runInContext('getProfileBgClass(primeUser)',ctx),'profile-bg-custom');
  assert.equal(vm.runInContext('getProfileBgClass(ultraUser)',ctx),'');
  const state = new Map();
  ctx.el = {style:{setProperty:(key,val)=>state.set(key,val),removeProperty:key=>state.delete(key)}};
  ctx.cover = cover;
  vm.runInContext("applyPrimeCoverToElement(el,'custom',cover)",ctx);
  assert.match(state.get('--kp-profile-skin'),/url\("data:image\/jpeg;base64/);
  vm.runInContext("applyPrimeCoverToElement(el,'forest_moss',cover)",ctx);
  assert.equal(state.has('--kp-profile-skin'),false);
});

test('tier gradients and compact phone/tablet layout have dedicated styling', () => {
  for(const name of ['plan-plus','plan-ultra','plan-prime']) {
    assert.match(html,new RegExp('subscription-plan '+name));
    assert.ok(css.includes('#subscription .'+name));
  }
  assert.match(css, /@media \(max-width:1050px\)/);
  assert.match(css, /@media \(max-width:760px\)/);
  assert.match(css, /@media \(max-width:390px\)/);
  assert.match(css, /#subscription\.active\s*\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(css, /@keyframes kapaniPrimeGlide/);
});

test('preview looks up actual own message nodes and reverts unsaved edits', () => {
  assert.match(html,/document\.querySelectorAll\('\.chat-msg\.me \.chat-bubble'\)/);
  assert.match(html,/b\.classList\.remove\(\.\.\.Object\.values\(CHAT_BUBBLE_CLASSES\)\)/);
  assert.match(html,/previewAvatarFrame\(u\.avatarFrame \|\| ''\)/);
  assert.match(html,/previewProfileBg\(u\.profileBgEffect \|\| ''\)/);
  assert.match(html,/previewChatBg\(u\.chatBubbleStyle \|\| ''\)/);
  assert.equal(fs.statSync(path.join(root,'assets/forest-road.webp')).size > 10000,true);
});
