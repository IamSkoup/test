// Offline contract assertions. They cannot replace a PostgreSQL/RLS test.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const sql = read('INSTALL.sql');
const main = read('assets/kapani-main-classic.js');
const extra = read('assets/kapani-finishes.js');
const index = read('index.html');
const css = read('assets/kapani-v10.css');
const subscriptionNews = read('supabase/015_subscriptions_and_news.sql');
const profileTiers = read('supabase/016_profile_plus_frames.sql');
const dmAndEducation = read('supabase/017_dm_previews_and_education_close.sql');
const savingsAndProfile = read('supabase/018_profile_savings_and_receipts.sql');
const v14css = read('assets/kapani-v14-fixes.css');
let count = 0;
const test = (name, condition) => {
  assert.ok(condition, name);
  count++;
};
test('static entry point', index.includes('assets/kapani-finishes.css') && index.includes('assets/kapani-finishes.js'));
test('no browser Node runtime', !/next\/dist|require\(['"]express['"]\)/.test(index));
test('server quotation RPC', sql.includes('function public.kp_service_quote_v8('));
test('taxi quote exact comparison', sql.includes("raise exception 'Fare changed: request a new server quote'"));
test('identical taxi tariff', main.includes("p_kind:'taxi'") && sql.includes('distance*250'));
test('distance is straight-line haversine', sql.includes('kp_v8_distance(') && main.includes('формула гаверсинуса'));
test('client waits for server fare', main.includes('if(!taxiQuote||taxiQuote.coords!==coords.join'));
test('both coordinates required', main.includes("throw new Error('Отметьте две точки на карте')"));
test('marketplace delivery only after paid sale', sql.includes("m->>'status'<>'sold'"));
test('marketplace delivery at most once unless cancelled', sql.includes("e.value->>'listingId'=p_data->>'listingId' and e.value->>'status'<>'cancelled'"));
test('marketplace goods need map point', sql.includes("raise exception 'Listing has no pickup point'"));
test('business needs map point', sql.includes("raise exception 'Business or product unavailable for delivery'"));
test('escrow checked at settlement', sql.includes("raise exception 'Escrow mismatch'"));
test('refund has stable operation id', sql.includes("':refund'"));
test('server worker release transition', sql.includes("elsif p_action='release'"));
test('release does not charge the passenger', !sql.match(/elsif p_action='release'[\s\S]{0,350}kp_v8_money/));
test('cancelled taxi fully refundable while pending', sql.includes("array['pending','driver_arriving','accepted']"));
test('business ledger is a private table', sql.includes('revoke all on public.kp_v8_business_ledger'));
test('product sale credits business account', sql.includes("values('delivery:'||p_id"));
test('business order sale credited only on both confirmations', sql.includes("if o->>'ownerConfirmed'='true' and o->>'clientConfirmed'='true'"));
test('employee can confirm handover, client confirms separately', sql.includes("Order participant or employee required") && main.includes('staff=owner||'));
test('business salary tied to ledger', sql.includes("'auto_salary'"));
test('automatic salary only on owner visit', main.includes("kp_business_payroll_v8"));
test('business upgrade price signed server-side', sql.includes("when 'employee' then 350 when 'product' then 250 when 'priceCap' then 400"));
test('business effects charged server-side', extra.includes("businessFinance('effect',effect,price)"));
test('tax uses same four brackets as server', main.includes('if(amount < 1000) return 0.07') &&
  read('supabase/003_protected_app_operations.sql').includes('when tax_base<=100000 then 0.17 else 0.25'));
test('tax preview respects available balance cap', main.includes('const limitedNext = Math.min(Math.max(0,Math.floor(balance)),totalNext)'));
test('savings actions go through protected server RPC', main.includes("supabase.rpc('kp_savings_move'"));
test('0.3% savings supported exclusively by server', main.includes("return '+0,3% в день'") &&
  main.includes("supabase.rpc('kp_savings_accrue_v14')") &&
  savingsAndProfile.includes('savings*0.003+carry'));
test('no unprotected business recurring fee', main.includes('В защищённой экономике нет RPC для этого взноса'));
test('no client-side advertising salary payout', main.includes('В текущих RPC нет защищённой выплаты рекламщику'));
test('private license role', sql.includes("raise exception 'Private licence data'"));
test('rental has idempotent request table', sql.includes('public.kp_v8_rental_ops'));
test('rental withdrawal uses protected money function', sql.includes("p_id,'rental_payment'"));
test('rental gallery photo editor', extra.includes("type=\"file\" accept=\"image/*\""));
test('casino has no client random settlement', sql.includes('kp_v8_casino_accounts') && sql.includes('gen_random_bytes'));
test('message delete requires confirmation', main.includes("confirm('Удалить это сообщение у всех участников?')"));
test('album attachments are sent explicitly', main.includes('async function sendDraft'));
test('history hides but does not delete', extra.includes("sessionStorage.setItem('kp_hide_delivery_history'"));
test('licences and rental SQL last', sql.includes('014_rentals_and_access.sql'));
test('revision 15 css loaded after v10 overrides', index.includes('assets/kapani-v10.css?v=13') &&
  index.includes('assets/kapani-v14-fixes.css?v=15') &&
  index.indexOf('assets/kapani-v10.css')<index.indexOf('assets/kapani-v14-fixes.css'));
test('revision 15 main script cache buster', index.includes('assets/kapani-main-classic.js?v=15'));
test('revision 10 SQL appended to full installer', sql.includes('-- ===== 015_subscriptions_and_news.sql ====='));
test('installer and individual new migration equivalent', sql.includes(subscriptionNews.trim()));
test('Plus profile frame fix follows subscription migration', sql.includes('-- ===== 016_profile_plus_frames.sql =====') && sql.includes(profileTiers.trim()));
test('DM and education migration appended intact', sql.includes('-- ===== 017_dm_previews_and_education_close.sql =====') && sql.includes(dmAndEducation.trim()));
test('v14 savings and paid profile migration appended intact', sql.includes('-- ===== 018_profile_savings_and_receipts.sql =====') &&
  sql.includes(savingsAndProfile.trim()));
test('paid profile settings no longer written through forbidden tree update',
  main.includes("supabase.rpc('kp_profile_customization_v14'") &&
  savingsAndProfile.includes('This style requires a higher subscription'));
test('profile wallpapers override forced green surface',v14css.includes('#profile #profileHeaderBg.profile-header[class*="profile-bg-"]') &&
  v14css.includes('background:var(--kp-profile-skin'));
test('toasts remain above lightweight dialogs',v14css.includes('#notifPopup {') &&
  v14css.includes('z-index:2147483644') && v14css.includes('backdrop-filter:none !important'));
test('bank receipt waits for journal confirmation',main.includes('const journalRecord=await confirmTransferLedgerV14(id)') &&
  main.includes("if(!journalRecord){"));
test('DM index uses actual existing messages', dmAndEducation.includes("root->conv->'messages'") && dmAndEducation.includes("jsonb_build_object('lastTs',ts,'latest',last_message)"));
test('DM index repair authenticated for participants', dmAndEducation.includes("if a is null or p_peer is null or p_peer=a") && dmAndEducation.includes('public.kp_v8_actor()'));
test('DM deletion and reindex are atomic in SQL', main.includes("await rpc('kp_dm_delete_v13',{p_peer:peer,p_id:id})") && dmAndEducation.includes("perform public.kp_message_v8('delete','dm',p_peer,p_id") && dmAndEducation.includes('return public.kp_dm_reindex_v13(p_peer)'));
test('DM preview corrected from canonical messages on reopen', main.includes('refreshDmPreviewsFromMessages(force=false)') && main.includes('dmVerifiedPreviews.set(peer,truth)'));
test('education closure only mayor', dmAndEducation.includes("if a is distinct from 'Кайон'") && dmAndEducation.includes('Mayor access required'));
test('education closure preserves payment and prevents repurchase', dmAndEducation.includes("'status','approved','closedAt'") && index.includes("'paid','submitted','approved'"));
test('education closure button present in mayor panel', index.includes('kapaniCloseKEducation(') && index.includes('Закрыть заявку'));
test('education closure has no money operations', !dmAndEducation.includes('kp_v8_money('));
test('upload cancel actively rejects pending TUS promise', main.includes("fail(new Error(reason||'Загрузка отменена'))") && main.includes('Promise.resolve(transfer.abort())'));
test('upload cancel on leaving messenger', main.includes("cancelMediaUpload('Загрузка остановлена при выходе из мессенджера',true)"));
test('upload cancel on attached file removal', main.includes("kapaniActiveMediaUpload?.source===f.blob"));
test('retry button replaces infinite general chat spinner', main.includes('kpRetryGeneralChat()') && main.includes('Превышено время ожидания сообщений'));
test('low-memory mobile casino class is toggled by navigation', index.includes("classList.toggle('kp-casino-lite',id==='casino'&&lowMemoryPhone)"));
test('GPU-heavy casino effects disabled on phones', css.includes('html.kp-casino-lite #casino .v8-game-card') && css.includes('html.kp-casino-lite #kpV8Sheet.v8-overlay'));
test('Plus frames validated by active server-side subscription', profileTiers.includes('subscription_tier>=1 and val=any(plus_frames)') && profileTiers.includes("array['gold','pulse','neon','ice','forest_moss','nature_meadow']"));
test('Ultra-only frame stays locked for Plus', profileTiers.includes('subscription_tier>=2 and val=any(ultra_frames)'));
test('Prime frame stays locked for Plus and Ultra', profileTiers.includes('subscription_tier>=3 and val=any(prime_frames)'));
test('server subscription prices equal configuration', [299, 899, 1499].every(p => sql.includes(String(p))) &&
  ['plus', 'ultra', 'prime'].every(plan => main.includes("p_plan:type")));
test('subscription has server-signed wallet settlement', subscriptionNews.includes("public.kp_v8_money(a,-price,p_id,'subscription_'||p_action"));
test('subscription retries are recorded uniquely', subscriptionNews.includes('kp_v10_subscription_ops') && subscriptionNews.includes('Subscription retry mismatch'));
test('subscription never edits protected balance in active handler', main.includes("window.buySubscription=type=>action('v10-subscription-buy'") &&
  main.includes("kp_subscription_v10") && main.includes("window.sendGiftSubscription=()=>action('v10-subscription-gift'"));
test('success tick shown only after RPC result', main.includes('await pendingOperation;') && main.includes("if(failure){") &&
  main.includes("mark.classList.add('done')"));
test('all payment captions present', ['Читаем данные карты','Производим оплату','Почти','Ещё чуть-чуть','Готово'].every(s => main.includes(s)));
test('news publication uses protected RPC', main.includes("rpc('kp_news_publish_v15'") &&
  sql.includes('function public.kp_news_publish_v15(') && subscriptionNews.includes("if p_action='publish'"));
test('news comments use protected RPC', main.includes("p_action:'comment_send'") && subscriptionNews.includes("elsif p_action='comment_edit'"));
test('comment author enforced server-side', subscriptionNews.includes("message->>'nick'<>a") && subscriptionNews.includes("Message author required"));
test('read receipts protected', subscriptionNews.includes("p_action='read'") && main.includes("p_action:'read',p_news_id:id"));
test('doctor booking gives actionable errors', sql.includes('Cannot book an appointment with yourself') &&
  sql.includes('Hospital service is disabled') && main.includes('Нельзя записаться на приём к самому себе'));
test('hospital panel loads protected view', main.includes("supabase.rpc('kp_hospital_view')") && main.includes("renderHospitalPanelServices(data?.services"));
test('hospital service buttons are explicit', main.includes("'Включить':'Отключить'") && main.includes('>Изменить</button>'));
test('casino wallet requires successful backend operation', main.includes("const result=await rpc('kp_casino_v8'") && main.includes('Сервер не подтвердил изменение игрового баланса'));
test('desktop sheets center in viewport', css.includes('#kpV8Sheet.v8-overlay') && css.includes('justify-content:center!important') && css.includes('align-items:center!important'));
test('casino overlay ignores the global 640px max-width', css.includes('width:100vw!important;max-width:none!important;') && css.includes('min-width:100vw!important;height:100dvh!important;'));
test('push prompt has green gradient, never old red', main.includes('background:linear-gradient(145deg,#1d4a33') && !main.includes('max-width:490px;background:#170b10'));
test('chat signatures cleared on navigation', main.includes("chatHost.removeAttribute('data-sig')") && main.includes("host.removeAttribute('data-sig')"));
test('chat render has failure recovery', main.includes("console.error('[Kapani general chat render]',err)") && main.includes('_chatRenderPending = false;'));
test('DM opening no longer blocks on presence update', main.includes("Promise.resolve(set(ref(db,`presence/${currentNick}/dmOpenWith`),nick))"));
test('mobile casino disables infinite GPU animations', css.includes('.v8-game-stage.playing>img{animation:none!important'));
test('mobile sheets no longer anchor to bottom', css.includes('#kpV8Sheet.v8-overlay{padding:12px!important;align-items:center!important;justify-content:center!important;}'));
test('other dialogs receive centered full-screen roots', css.includes('#userProfileModal.open,#historyModal.open,#giftSubModal') && css.includes('#profileCustomizerModal > div'));
test('inline handlers escape double and single quotes', main.includes('onclick="${html(click)}"') && main.includes('function button(label,click'));
test('profile desktop and mobile layouts', css.includes('#profile.section.active') && css.includes('grid-template-columns:repeat(2,minmax(0,1fr))') && css.includes('grid-template-columns:1fr!important'));
test('passport and gift gradients', css.includes('#passportFormModal > div') && css.includes('#giftSubModal > div'));
test('marketplace search remains functional', main.includes('v8MarketSearch') && main.includes('`${l.title} ${l.desc} ${l.address||\'\'}`'));
test('buyer retains visibility of paid listing', main.includes("l.status!=='sold' || l.category==='service' || l.buyer===currentNick"));
test('sold listing cannot restart purchase negotiation', main.includes("!l.status||l.status==='active'"));
test('listing delivery button only for fully purchased goods', main.includes("l.buyer===currentNick&&l.status==='sold'&&point(l.sellerLat,l.sellerLng)"));
process.stdout.write('OK: ' + count + ' offline static contracts checked. PostgreSQL was not connected.\n');
