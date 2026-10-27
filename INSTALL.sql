-- КАПАНИ: безопасное обновление существующей базы (миграции 008–013).
-- Сначала сделайте резервную копию Supabase. Проверьте, что это проект Kapani.
-- Требует установленную схему 001–007 и защищённые таблицы kp_profiles, kp_wallets, kp_ledger.
-- Не применяйте файл к чистой базе.
do $preflight$
begin
 if to_regclass('public.kp_tree_roots') is null or to_regclass('public.kp_profiles') is null or to_regclass('public.kp_wallets') is null or to_regclass('public.kp_ledger') is null then
   raise exception 'Required Kapani schema is missing: apply/check migrations 001–007 and protected wallet tables first.';
 end if;
 if to_regprocedure('public.kp_tree_access(text,text,jsonb,bigint)') is null or to_regprocedure('public.kp_job_application(text,text,text,text)') is null or to_regprocedure('public.kp_market_action(text,text,jsonb)') is null then
   raise exception 'Kapani migrations 001–007 are not installed or have unexpected signatures.';
 end if;
 if not exists(select 1 from pg_extension where extname='pgcrypto') then raise exception 'pgcrypto extension is required.';end if;
end $preflight$;

-- ===== 008_access_and_profiles.sql =====
-- Apply after 001–007. Additive: no accounts, balances or requests are deleted.

create or replace function public.kp_v8_actor() returns text language sql stable security definer set search_path='' as $$
 select nickname from public.kp_profiles where user_id=auth.uid();
$$;
create or replace function public.kp_v8_role(n text, r text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select document->n->>'job'=r or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(document->n->'employments')='array' then document->n->'employments' else '[]'::jsonb end) e where e->>'type'='municipal' and e->>'role'=r) from public.kp_tree_roots where branch='users'),false);
$$;
create or replace function public.kp_v8_put(b text,d jsonb) returns void language plpgsql security definer set search_path='' as $$
declare v bigint;
begin
 insert into public.kp_tree_roots(branch,document,revision) values(b,d,1)
 on conflict(branch) do update set document=excluded.document,revision=kp_tree_roots.revision+1,updated_at=now() returning revision into v;
 insert into public.kp_tree_revisions(branch,revision) values(b,v) on conflict(branch) do update set revision=excluded.revision;
end; $$;
create or replace function public.kp_v8_public_profile(d jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(coalesce(d,'{}'::jsonb)) where key=any(array['nick','displayName','avatar','avatarUrl','photoURL','bio','about','description','profileDescription','job','employments','displayJob','vehicle','lastSeen','subscription','subscriptionExpiry','avatarFrame','profileBg','profileBgEffect','profileCustomBg','chatBubbleStyle','nicknameColor','nicknameEmoji','accountVerified']);
$$;
-- Keep the old implementation private so callers cannot bypass the new checks.
do $$ begin
 if to_regprocedure('public.kp_tree_access_v7(text,text,jsonb,bigint)') is null then
 alter function public.kp_tree_access(text,text,jsonb,bigint) rename to kp_tree_access_v7;
 end if;
end $$;
revoke all on function public.kp_tree_access_v7(text,text,jsonb,bigint) from public,anon,authenticated;
create or replace function public.kp_tree_access(p_operation text,p_path text default '',p_payload jsonb default null,p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); parts text[]:=string_to_array(trim(both '/' from p_path),'/'); b text; d jsonb; v bigint; x jsonb; staff boolean;
begin
 b:=parts[1]; if b='apps' then b:='jobApps'; parts[1]:=b; p_path:=array_to_string(parts,'/'); end if;
 if p_operation<>'read' then
   if b='chat' or (b='dms' and parts[3]='messages') then raise exception 'Use protected message service';end if;
   return public.kp_tree_access_v7(p_operation,p_path,p_payload,p_expected_revision);
 end if;
 if a is null then return jsonb_build_object('value',null,'revision',0); end if;
 staff:=a='Кайон' or public.kp_v8_role(a,'КСБ') or public.kp_v8_role(a,'Полицейский');
 select document,revision into d,v from public.kp_tree_roots where branch=b;
 d:=coalesce(d,'{}');
 if b='users' then
   if cardinality(parts)=1 then
     select coalesce(jsonb_object_agg(key,case when key=a or a='Кайон' then value-'passwordHash'-'passwordHashSalt' else public.kp_v8_public_profile(value) end),'{}') into x from jsonb_each(d);
   elsif parts[2]=a or a='Кайон' then x:=d #> parts[2:cardinality(parts)];
   else
     x:=public.kp_v8_public_profile(d->parts[2]);
     if cardinality(parts)>2 then x:=x #> parts[3:cardinality(parts)]; end if;
   end if;
   if jsonb_typeof(x)='object' then x:=x-'passwordHash'-'passwordHashSalt'; end if;
 elsif b='walls' then
   if cardinality(parts)<2 then raise exception 'Choose a profile'; end if;
   x:=d #> parts[2:cardinality(parts)];
 elsif b in ('passports','licenses') then
   if cardinality(parts)<2 or (parts[2]<>a and not staff) then raise exception 'Private profile data'; end if;
   x:=d #> parts[2:cardinality(parts)];
 elsif b in ('jobApps','businessApps','bizDeleteRequests','janitorSubmissions','atmRequests','deputyProposals','policeRequests','civicRequests') then
   if a<>'Кайон' then select coalesce(jsonb_object_agg(key,value),'{}') into d from jsonb_each(d) where coalesce(value->>'from',value->>'owner',value->>'worker',value->>'nick',value->>'author',value->>'officer')=a; end if;
   x:=case when cardinality(parts)=1 then d else d #> parts[2:cardinality(parts)] end;
 elsif b in ('orders','deliveryCustomOrders') then
   if a<>'Кайон' then select coalesce(jsonb_object_agg(key,value),'{}') into d from jsonb_each(d)
     where value->>'client'=a or value->>'worker'=a or (value->>'status' in ('pending','waiting') and public.kp_v8_role(a,case when b='orders' then 'Водитель' else 'Доставщик' end));end if;
   x:=case when cardinality(parts)=1 then d else d #> parts[2:cardinality(parts)] end;
 elsif b in ('bizOrders','bizJobApps','bizComplaints') then
   select coalesce(jsonb_object_agg(biz.key,coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(biz.value)e
     where a='Кайон' or (select document->biz.key->>'owner' from public.kp_tree_roots where branch='businesses')=a
       or coalesce(e.value->>'client',e.value->>'from',e.value->>'applicant')=a),'{}')),'{}') into d from jsonb_each(d)biz;
   x:=case when cardinality(parts)=1 then d else d #> parts[2:cardinality(parts)] end;
 elsif b='hospital' then
   x:=public.kp_hospital_view();
   if cardinality(parts)>1 then x:=x #> parts[2:cardinality(parts)]; end if;
 else return public.kp_tree_access_v7(p_operation,p_path,p_payload,p_expected_revision);
 end if;
 return jsonb_build_object('value',x,'revision',coalesce(v,0));
end; $$;
revoke all on function public.kp_tree_access(text,text,jsonb,bigint) from public;
grant execute on function public.kp_tree_access(text,text,jsonb,bigint) to anon,authenticated;
create or replace function public.kp_license_status(p_target text) returns jsonb language plpgsql security definer set search_path='' as $$
declare d jsonb;
begin
 d:=public.kp_tree_access('read','licenses/'||p_target);
 return coalesce((select document->p_target->'licenses' from public.kp_tree_roots where branch='users'),'{}')||coalesce(d->'value','{}');
end; $$;
-- Merge the old inbox once; new records take precedence.
insert into public.kp_tree_roots(branch,document) select 'jobApps',document from public.kp_tree_roots where branch='apps'
 on conflict(branch) do update set document=excluded.document||kp_tree_roots.document;
-- Publication metadata is committed together with the existing marketplace RPC.
do $$ begin
 if to_regprocedure('public.kp_market_action_v7(text,text,jsonb)') is null then
 alter function public.kp_market_action(text,text,jsonb) rename to kp_market_action_v7;
 end if;
end $$;
revoke all on function public.kp_market_action_v7(text,text,jsonb) from public,anon,authenticated;
create or replace function public.kp_market_action(p_action text,p_listing_id text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; d jsonb; photos jsonb; pic jsonb;
begin
 if p_action='create' then
   photos:=coalesce(p_payload->'photos','[]');
   if jsonb_typeof(photos)<>'array' or jsonb_array_length(photos)>8 then raise exception 'Maximum 8 photos'; end if;
   for pic in select value from jsonb_array_elements(photos) loop
     if jsonb_typeof(pic)<>'string' or length(pic#>>'{}')>2500000 or (pic#>>'{}') !~ '^(https://|data:image/(jpeg|png|webp);base64,)' then raise exception 'Invalid image'; end if;
   end loop;
   if (p_payload ? 'sellerLat')<>(p_payload ? 'sellerLng') then raise exception 'Select both coordinates'; end if;
   if p_payload ? 'sellerLat' and not public.kp_v8_point(p_payload->>'sellerLat',p_payload->>'sellerLng') then raise exception 'Invalid map point'; end if;
 end if;
 result:=public.kp_market_action_v7(p_action,p_listing_id,p_payload);
 if p_action='create' then
   select document into d from public.kp_tree_roots where branch='marketplace' for update;
   d:=jsonb_set(d,array[p_listing_id],(d->p_listing_id)||jsonb_build_object('photos',photos,'createdAt',(extract(epoch from now())*1000)::bigint,'condition',left(coalesce(p_payload->>'condition',''),80),'address',left(coalesce(p_payload->>'address',''),200))||case when p_payload ? 'sellerLat' then jsonb_build_object('sellerLat',p_payload->'sellerLat','sellerLng',p_payload->'sellerLng') else '{}'::jsonb end);
   perform public.kp_v8_put('marketplace',d);
 end if;
 return result;
end; $$;
create or replace function public.kp_v8_point(lat text,lng text) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if lat is null or lng is null or lat='' or lng='' then return false; end if;
 return lat::numeric between -90 and 90 and lng::numeric between -180 and 180;
exception when others then return false;
end; $$;
revoke all on function public.kp_v8_actor(),public.kp_v8_role(text,text),public.kp_v8_put(text,jsonb),public.kp_v8_public_profile(jsonb),public.kp_v8_point(text,text) from public,anon,authenticated;
revoke all on function public.kp_market_action(text,text,jsonb) from public,anon;
grant execute on function public.kp_market_action(text,text,jsonb) to authenticated;


-- ===== 010_casino_and_events.sql =====
create table if not exists public.kp_v8_casino_accounts(user_id uuid primary key, balance bigint not null default 0 check(balance between 0 and 1000000), day date, deposits bigint not null default 0, wagers bigint not null default 0, last_round timestamptz);
create table if not exists public.kp_v8_casino_ops(id uuid primary key,user_id uuid not null,args jsonb not null,result jsonb not null,created_at timestamptz not null default now());
create table if not exists public.kp_v8_events(id uuid primary key,title text not null,kind text not null,sides jsonb not null,closes_at timestamptz not null,status text not null default 'open',winner integer,budget bigint not null,liability bigint not null default 0,created_at timestamptz not null default now());
create table if not exists public.kp_v8_bets(id uuid primary key,user_id uuid not null,event_id uuid not null references public.kp_v8_events(id),side integer not null,stake bigint not null,payout bigint not null,status text not null default 'pending');
alter table public.kp_v8_casino_accounts enable row level security;
alter table public.kp_v8_casino_ops enable row level security;
alter table public.kp_v8_events enable row level security;
alter table public.kp_v8_bets enable row level security;
revoke all on public.kp_v8_casino_accounts,public.kp_v8_casino_ops,public.kp_v8_events,public.kp_v8_bets from anon,authenticated;
create or replace function public.kp_v8_random(n integer) returns integer language plpgsql volatile security definer set search_path='' as $$
declare b bytea; v bigint; lim bigint;
begin
 if n<1 or n>1000000 then raise exception 'Invalid random range'; end if;
 lim:=4294967296-(4294967296%n);
 loop
 b:=extensions.gen_random_bytes(4);
 v:=get_byte(b,0)::bigint*16777216+get_byte(b,1)::bigint*65536+get_byte(b,2)::bigint*256+get_byte(b,3);
 exit when v<lim;
 end loop;
 return (v%n)::integer;
end; $$;
-- Internal helper; call only while holding the users root lock. All changes
-- enter the protected ledger and refresh the compatibility profile balance.
create or replace function public.kp_v8_money(n text,delta bigint,op uuid,kind text,details jsonb default '{}') returns bigint language plpgsql security definer set search_path='' as $$
declare uid uuid; bal bigint; d jsonb;
begin
 if delta is null or op is null or n is null then raise exception 'Invalid financial operation';end if;
 select user_id into uid from public.kp_profiles where nickname=n;
 if uid is null then raise exception 'Account missing'; end if;
 select balance into bal from public.kp_wallets where user_id=uid for update;
 if bal is null or bal+delta<0 or bal+delta>1000000000 then raise exception 'Insufficient funds or balance limit'; end if;
 if exists(select 1 from public.kp_ledger where operation_id=op) then raise exception 'Duplicate financial operation'; end if;
 update public.kp_wallets set balance=balance+delta,updated_at=now() where user_id=uid;
 insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details) values(op,uid,'wallet',delta,kind,details);
 select document into d from public.kp_tree_roots where branch='users' for update;
 perform public.kp_v8_put('users',jsonb_set(d,array[n,'balance'],to_jsonb(bal+delta),true));
 return bal+delta;
end; $$;
create or replace function public.kp_casino_v8(p_action text,p_id uuid default null,p_amount bigint default 0,p_game text default null,p_choice text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); u jsonb; c public.kp_v8_casino_accounts%rowtype; old public.kp_v8_casino_ops%rowtype; args jsonb; result jsonb; payout bigint:=0; outcome jsonb; x integer; y integer; z integer; main bigint; today date:=(now() at time zone 'Europe/Moscow')::date;
begin
 if a is null then raise exception 'Authentication required'; end if;
 select document->a into u from public.kp_tree_roots where branch='users' for update;
 insert into public.kp_v8_casino_accounts(user_id,day) values(auth.uid(),today) on conflict do nothing;
 select * into c from public.kp_v8_casino_accounts where user_id=auth.uid() for update;
 select balance into main from public.kp_wallets where user_id=auth.uid();
 if c.day is distinct from today then c.day:=today;c.deposits:=0;c.wagers:=0; end if;
 if p_action='view' then return jsonb_build_object('balance',c.balance,'main',main,'dailyWagerRemaining',greatest(0,20000-c.wagers)); end if;
 if p_action not in ('deposit','withdraw','play') or p_id is null then raise exception 'Invalid operation'; end if;
 args:=jsonb_build_object('action',p_action,'amount',p_amount,'game',p_game,'choice',p_choice);
 select * into old from public.kp_v8_casino_ops where id=p_id;
 if found then
   if old.user_id<>auth.uid() or old.args<>args then raise exception 'Request identifier mismatch'; end if;
   return old.result;
 end if;
 if coalesce(u->>'accountFrozen','false')='true' or coalesce(u->>'accountVerified','false')<>'true' or coalesce(u->'roles'->>'migrant','false')='true' then raise exception 'Verified active account required'; end if;
 if p_amount is null or p_amount<1 or p_amount>10000 then raise exception 'Amount must be between 1 and 10000'; end if;
 if p_action='deposit' then
   if c.deposits+p_amount>10000 then raise exception 'Daily deposit limit: 10000'; end if;
   main:=public.kp_v8_money(a,-p_amount,p_id,'casino_deposit'); c.balance:=c.balance+p_amount; c.deposits:=c.deposits+p_amount;
 elsif p_action='withdraw' then
   if c.balance<p_amount then raise exception 'Insufficient casino balance'; end if;
   main:=public.kp_v8_money(a,p_amount,p_id,'casino_withdraw'); c.balance:=c.balance-p_amount;
 else
   if p_amount>1000 or c.wagers+p_amount>20000 then raise exception 'Stake limit: 1000; daily turnover: 20000'; end if;
   if c.balance<p_amount then raise exception 'Insufficient casino balance'; end if;
   if c.last_round>clock_timestamp()-interval '2 seconds' then raise exception 'Wait for the current round'; end if;
   if p_game='roulette' then
     if p_choice is null or p_choice not in ('red','black','zero') then raise exception 'Select a roulette field'; end if;
     x:=public.kp_v8_random(37); outcome:=to_jsonb(x);
     if (p_choice='zero' and x=0) then payout:=p_amount*36;
     elsif x>0 and ((p_choice='red' and x=any(array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36])) or (p_choice='black' and not(x=any(array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36])))) then payout:=p_amount*2; end if;
   elsif p_game='dice' then
     if coalesce(p_choice,'') !~ '^[1-6]$' then raise exception 'Choose 1 to 6'; end if;
     x:=public.kp_v8_random(6)+1;outcome:=to_jsonb(x);if x=p_choice::integer then payout:=floor(p_amount*5.7);end if;
   elsif p_game='slots' then
     x:=public.kp_v8_random(6);y:=public.kp_v8_random(6);z:=public.kp_v8_random(6);outcome:=jsonb_build_array(x,y,z);
     if x=y and y=z then payout:=p_amount*12;elsif x=y or y=z or x=z then payout:=floor(p_amount*1.5);end if;
   elsif p_game='wheel' then
     x:=public.kp_v8_random(20);y:=case when x<11 then 0 when x<16 then 1 when x<18 then 2 else 5 end;outcome:=to_jsonb(y);payout:=p_amount*y;
   else raise exception 'Unknown game'; end if;
   c.balance:=c.balance-p_amount+payout;c.wagers:=c.wagers+p_amount;c.last_round:=clock_timestamp();
 end if;
 update public.kp_v8_casino_accounts set balance=c.balance,day=c.day,deposits=c.deposits,wagers=c.wagers,last_round=c.last_round where user_id=auth.uid();
 result:=jsonb_build_object('id',p_id,'balance',c.balance,'main',main,'outcome',outcome,'payout',payout,'stake',p_amount,'game',p_game);
 insert into public.kp_v8_casino_ops(id,user_id,args,result) values(p_id,auth.uid(),args,result);
 return result;
end; $$;
create or replace function public.kp_events_v8(p_action text,p_id uuid default null,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); e public.kp_v8_events%rowtype; bet public.kp_v8_bets%rowtype; n text; sides jsonb; side integer; stake bigint; pay bigint; total bigint:=0; winning_side integer; arr jsonb; item jsonb; u jsonb;
begin
 if a is null then raise exception 'Authentication required'; end if;
 if p_action='view' then
   select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc),'[]') into arr from (select * from public.kp_v8_events order by created_at desc limit 100)t;
   return jsonb_build_object('events',arr,'bets',coalesce((select jsonb_agg(to_jsonb(b)) from public.kp_v8_bets b where user_id=auth.uid()),'[]'));
 end if;
 select document->a into u from public.kp_tree_roots where branch='users' for update;
 if p_id is null then raise exception 'Request ID required'; end if;
 if p_action='create' then
   if a<>'Кайон' then raise exception 'Mayor access required'; end if;
   if exists(select 1 from public.kp_v8_events where id=p_id) then return jsonb_build_object('ok',true); end if;
   sides:=p_data->'sides';
   if coalesce(jsonb_typeof(sides),'null')<>'array' or jsonb_array_length(sides) not between 2 and 8 or length(trim(coalesce(p_data->>'title',''))) not between 3 and 120 or p_data->>'kind' not in ('sport','battle') then raise exception 'Invalid event'; end if;
   for item in select value from jsonb_array_elements(sides) loop
     if length(trim(coalesce(item->>'name',''))) not between 1 and 80 or item->>'odds' is null or (item->>'odds')::numeric not between 1.01 and 20 then raise exception 'Invalid side or odds'; end if;
   end loop;
   stake:=(p_data->>'budget')::bigint;
   if stake is null or p_data->>'closesAt' is null or stake not between 100 and 100000 or (p_data->>'closesAt')::timestamptz<=now() then raise exception 'Invalid budget or deadline'; end if;
   perform public.kp_v8_money(a,-stake,p_id,'event_reserve',jsonb_build_object('title',p_data->>'title'));
   insert into public.kp_v8_events(id,title,kind,sides,closes_at,budget) values(p_id,trim(p_data->>'title'),p_data->>'kind',sides,(p_data->>'closesAt')::timestamptz,stake);
   return jsonb_build_object('ok',true);
 end if;
 if p_action='bet' then
   select * into bet from public.kp_v8_bets where id=p_id;
   if found then
     if bet.user_id<>auth.uid() or bet.event_id<>(p_data->>'event')::uuid or bet.side<>(p_data->>'side')::integer or bet.stake<>(p_data->>'stake')::bigint then raise exception 'Request mismatch'; end if;
     return to_jsonb(bet);
   end if;
   if coalesce(u->>'accountVerified','false')<>'true' or coalesce(u->>'accountFrozen','false')='true' then raise exception 'Verified active account required'; end if;
   select * into e from public.kp_v8_events where id=(p_data->>'event')::uuid for update;
   side:=(p_data->>'side')::integer;stake:=(p_data->>'stake')::bigint;
   if e.id is null or e.status<>'open' or e.closes_at<=now() or side is null or stake is null or side<0 or side>=jsonb_array_length(e.sides) or stake not between 10 and 1000 then raise exception 'Bet unavailable'; end if;
   if (select count(*) from public.kp_v8_bets where event_id=e.id and user_id=auth.uid())>=10 then raise exception 'Maximum 10 bets per event'; end if;
   pay:=floor(stake*(e.sides->side->>'odds')::numeric);
   if e.liability+pay>e.budget+stake then raise exception 'Event payout reserve exhausted'; end if;
   perform public.kp_v8_money(a,-stake,p_id,'event_bet',jsonb_build_object('event',e.id,'side',side));
   insert into public.kp_v8_bets(id,user_id,event_id,side,stake,payout) values(p_id,auth.uid(),e.id,side,stake,pay);
   update public.kp_v8_events set budget=budget+stake,liability=liability+pay where id=e.id;
 else
   if a<>'Кайон' or p_action not in ('settle','cancel') then raise exception 'Mayor access required'; end if;
   select * into e from public.kp_v8_events where id=p_id for update;
   if e.id is null then raise exception 'Event missing'; end if;
   if e.status<>'open' then return jsonb_build_object('ok',true,'repeated',true); end if;
   winning_side:=(p_data->>'winner')::integer;
   if p_action='settle' and (winning_side is null or winning_side<0 or winning_side>=jsonb_array_length(e.sides) or now()<e.closes_at) then raise exception 'Wait for closing and select winner'; end if;
   for bet in select * from public.kp_v8_bets where event_id=e.id order by user_id loop
     pay:=case when p_action='cancel' then bet.stake when bet.side=winning_side then bet.payout else 0 end;
     if pay>0 then
       select nickname into n from public.kp_profiles where user_id=bet.user_id;
       perform public.kp_v8_money(n,pay,(md5(bet.id::text||':result'))::uuid,'event_result',jsonb_build_object('event',e.id));
       total:=total+pay;
     end if;
     update public.kp_v8_bets set status=case when p_action='cancel' then 'refunded' when pay>0 then 'won' else 'lost' end where id=bet.id;
   end loop;
   perform public.kp_v8_money(a,e.budget-total,(md5(e.id::text||':remainder'))::uuid,'event_reserve_return');
   update public.kp_v8_events set status=case when p_action='cancel' then 'cancelled' else 'settled' end,winner=winning_side,budget=0 where id=e.id;
 end if;
 return jsonb_build_object('ok',true);
end; $$;
revoke all on function public.kp_v8_random(integer),public.kp_v8_money(text,bigint,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.kp_casino_v8(text,uuid,bigint,text,text),public.kp_events_v8(text,uuid,jsonb) from public,anon;
grant execute on function public.kp_casino_v8(text,uuid,bigint,text,text),public.kp_events_v8(text,uuid,jsonb) to authenticated;


-- ===== 009_services.sql =====
-- Install after 010 (uses kp_v8_money). See INSTALL.sql for the correct order.

create or replace function public.kp_v8_distance(a numeric,b numeric,c numeric,d numeric) returns numeric language sql immutable set search_path='' as $$
 select (6371*2*asin(least(1,sqrt(power(sin(radians((c-a)::double precision)/2),2)+cos(radians(a::double precision))*cos(radians(c::double precision))*power(sin(radians((d-b)::double precision)/2),2)))))::numeric;
$$;
create or replace function public.kp_service_v8(p_kind text,p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); branch_name text; root jsonb; orders jsonb; o jsonb; users jsonb; u jsonb; b jsonb; item jsonb; m jsonb; doctor text; worker text; supplier text; price bigint; product_price bigint:=0; distance numeric; total bigint; at_ms bigint:=(extract(epoch from now())*1000)::bigint; expected text; entry record;
begin
 if a is null then raise exception 'Authentication required'; end if;
 if p_kind not in ('taxi','delivery','hospital') or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid service request'; end if;
 branch_name:=case p_kind when 'taxi' then 'orders' when 'delivery' then 'deliveryCustomOrders' else 'hospital' end;
 insert into public.kp_tree_roots(branch) values('users'),(branch_name) on conflict do nothing;
 select document into users from public.kp_tree_roots where branch='users' for update; u:=users->a;
 select document into root from public.kp_tree_roots where branch=branch_name for update;
 orders:=case when p_kind='hospital' then coalesce(root->'appointments','{}') else root end;
 o:=orders->p_id;
 if p_action='create' then
   if o is not null then
     if coalesce(o->>'client',o->>'clientNick')<>a then raise exception 'Request belongs to another user'; end if;
     return o;
   end if;
   if coalesce(u->>'accountFrozen','false')='true' or coalesce(u->>'accountVerified','false')<>'true' then raise exception 'Verified active account required'; end if;
   if p_kind='hospital' then
     item:=root->'services'->(p_data->>'serviceId');
     select key into doctor from jsonb_each(users) where public.kp_v8_role(key,'Врач') order by key limit 1;
     if item is null or item->>'active'='false' or doctor is null or doctor=a then raise exception 'Service unavailable'; end if;
     if p_data->>'date' is null or (p_data->>'date')::date<(now() at time zone 'Europe/Moscow')::date or (p_data->>'date')::date>(now() at time zone 'Europe/Moscow')::date+90 or coalesce(p_data->>'time','')!~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid appointment time'; end if;
     if ((p_data->>'date')||' '||(p_data->>'time'))::timestamp <= now() at time zone 'Europe/Moscow' then raise exception 'Choose a future appointment'; end if;
     if exists(select 1 from jsonb_each(orders) e where e.value->>'doctorNick'=doctor and e.value->>'date'=p_data->>'date' and e.value->>'time'=p_data->>'time' and e.value->>'status' not in ('cancelled','rejected','paid')) then raise exception 'This time is already booked'; end if;
     price:=coalesce((item->>'price')::bigint,0);
     if price not between 0 and 10000 then raise exception 'Invalid service price'; end if;
     o:=jsonb_build_object('id',p_id,'client',a,'clientNick',a,'clientName',coalesce(u->>'displayName',a),'clientSurname','','worker',doctor,'doctorNick',doctor,'serviceId',p_data->>'serviceId','serviceName',item->>'name','price',price,'date',p_data->>'date','time',p_data->>'time','status','pending','paymentStatus','reserved');
   else
     if not public.kp_v8_point(p_data->>'destLat',p_data->>'destLng') then raise exception 'Select destination on map'; end if;
     if p_kind='taxi' then
       if not public.kp_v8_point(p_data->>'clientLat',p_data->>'clientLng') then raise exception 'Select pickup on map'; end if;
       if exists(select 1 from jsonb_each(orders) e where e.value->>'client'=a and e.value->>'type'='taxi' and e.value->>'status' not in ('paid','cancelled','completed')) then raise exception 'You already have an active ride'; end if;
       distance:=public.kp_v8_distance((p_data->>'clientLat')::numeric,(p_data->>'clientLng')::numeric,(p_data->>'destLat')::numeric,(p_data->>'destLng')::numeric);price:=greatest(1,round(distance*250)::bigint);
       o:=jsonb_build_object('id',p_id,'client',a,'type','taxi','status','pending','clientLat',p_data->'clientLat','clientLng',p_data->'clientLng','destLat',p_data->'destLat','destLng',p_data->'destLng','price',price,'distanceKm',distance,'info',left(coalesce(p_data->>'info','Поездка по карте'),400));
       select key into worker from jsonb_each(users) where key<>a and public.kp_v8_role(key,'Водитель') and value->'settings'->>'taxiOnline'='true' and coalesce((value->>'lastSeen')::bigint,0)>at_ms-120000 and not exists(select 1 from jsonb_each(orders) e where e.value->>'worker'=key and e.value->>'status' in ('accepted','driver_arriving','in_progress','waiting_payment')) order by key limit 1;
       if worker is not null then o:=o||jsonb_build_object('worker',worker,'status','driver_arriving','driverAvatar',users->worker->>'avatar','driverVehicle',users->worker->>'vehicle'); end if;
     else
       if p_data->>'source'='business' then
         select document->(p_data->>'bizId') into b from public.kp_tree_roots where branch='businesses';item:=b->'products'->(p_data->>'productId');
         if b is null or item is null or b->>'status'<>'active' or coalesce(b->>'delivery','false')<>'true' or item->>'available'='false' or not public.kp_v8_point(b->>'lat',b->>'lng') then raise exception 'Business or product unavailable for delivery'; end if;
         supplier:=b->>'owner';product_price:=(item->>'price')::bigint;
         if product_price is null or product_price not between 1 and 100000 then raise exception 'Invalid product price'; end if;
         o:=jsonb_build_object('source','business','bizId',p_data->>'bizId','productId',p_data->>'productId','from',b->>'name','items',item->>'name','productName',item->>'name','productPrice',product_price,'supplier',supplier,'pickupLat',b->'lat','pickupLng',b->'lng');
       elsif p_data->>'source'='marketplace' then
         select document->(p_data->>'listingId') into m from public.kp_tree_roots where branch='marketplace' for update;
         if m is null or not public.kp_v8_point(m->>'sellerLat',m->>'sellerLng') then raise exception 'Listing has no pickup point'; end if;
         if m->>'category' in ('service','work') then raise exception 'Only physical goods can be delivered'; end if;
         if exists(select 1 from jsonb_each(orders) e where e.value->>'listingId'=p_data->>'listingId' and e.value->>'status'<>'cancelled') then raise exception 'Delivery already exists for this purchase'; end if;
         if m->>'status'='meeting_confirmed' and m->>'buyer'=a then
           perform public.kp_market_action('purchase',p_data->>'listingId',coalesce(p_data->'purchase','{}'));
         elsif m->>'status'<>'sold' or m->>'buyer' is distinct from a then raise exception 'Seller must confirm the purchase first'; end if;
         o:=jsonb_build_object('source','marketplace','listingId',p_data->>'listingId','from',m->>'seller','items',m->>'title','listingTitle',m->>'title','pickupLat',m->'sellerLat','pickupLng',m->'sellerLng');
       else raise exception 'Select delivery source'; end if;
       if supplier=a then raise exception 'Cannot purchase your own product'; end if;
       distance:=public.kp_v8_distance((o->>'pickupLat')::numeric,(o->>'pickupLng')::numeric,(p_data->>'destLat')::numeric,(p_data->>'destLng')::numeric);price:=greatest(1,round(distance*200)::bigint);
       o:=o||jsonb_build_object('id',p_id,'client',a,'status','waiting','deliveryLat',p_data->'destLat','deliveryLng',p_data->'destLng','deliveryPrice',price,'priceOffer',price,'price',price,'distanceKm',distance,'address',left(coalesce(p_data->>'address','Точка на карте'),200),'notes',left(coalesce(p_data->>'notes',''),1000),'contact',left(coalesce(p_data->>'contact',''),100));
     end if;
     if distance<=0 or distance>100 then raise exception 'Route must be between 0 and 100 km'; end if;
   end if;
   total:=price+product_price;
   if total>0 then perform public.kp_v8_money(a,-total,(md5(p_kind||p_id||':reserve'))::uuid,'service_reserve',jsonb_build_object('service',p_kind,'order',p_id));end if;
   o:=o||jsonb_build_object('escrowAmount',total,'createdAt',at_ms,'updatedAt',at_ms,'clientConfirmed',false,'workerConfirmed',false);
 else
   if o is null then raise exception 'Order missing'; end if;
   worker:=o->>'worker';price:=(o->>'price')::bigint;
   if p_action='take' then
     if coalesce(o->>'client',o->>'clientNick')=a or not public.kp_v8_role(a,case when p_kind='taxi' then 'Водитель' else 'Доставщик' end) then raise exception 'Worker access required'; end if;
     if o->>'worker'=a then return o; end if;
     if o->>'status' not in ('pending','waiting') or worker is not null then raise exception 'Order already assigned'; end if;
     if exists(select 1 from jsonb_each(orders) e where e.value->>'worker'=a and e.value->>'status' in ('driver_arriving','accepted','client_confirmed','in_progress','waiting_payment','delivered')) then raise exception 'Finish your active order first'; end if;
     o:=o||jsonb_build_object('worker',a,'status',case when p_kind='taxi' then 'driver_arriving' else 'client_confirmed' end,'driverAvatar',u->>'avatar','driverVehicle',u->>'vehicle','acceptedAt',at_ms);
   elsif p_action='cancel' then
     if a is distinct from o->>'client' and a is distinct from worker and a<>'Кайон' and not(p_kind='hospital' and public.kp_v8_role(a,'Помощник врача')) then raise exception 'Not an order participant'; end if;
     if o->>'status' in ('cancelled','rejected') then return o; end if;
     if o->>'status' not in ('pending','waiting','accepted','driver_arriving','client_confirmed') then raise exception 'Cannot cancel after service has started'; end if;
     total:=coalesce((o->>'escrowAmount')::bigint,0);
     if total>0 then perform public.kp_v8_money(o->>'client',total,(md5(p_kind||p_id||':refund'))::uuid,'service_refund',jsonb_build_object('order',p_id));end if;
     o:=o||jsonb_build_object('status','cancelled','escrowAmount',0,'paymentStatus','refunded');
   elsif p_action='location' then
     if a is distinct from worker or p_kind='hospital' or o->>'status' not in ('driver_arriving','accepted','client_confirmed','in_progress') or not public.kp_v8_point(p_data->>'lat',p_data->>'lng') then raise exception 'Location update unavailable'; end if;
     o:=o||jsonb_build_object('driverLat',p_data->'lat','driverLng',p_data->'lng','driverLocationUpdatedAt',at_ms);
   elsif p_action='start' then
     if a is distinct from worker and not (p_kind='hospital' and public.kp_v8_role(a,'Помощник врача')) then raise exception 'Assigned worker required'; end if;
     expected:=case when p_kind='hospital' then 'accepted' else 'in_progress' end;
     if o->>'status'=expected then return o; end if;
     if o->>'status' not in ('pending','accepted','driver_arriving','client_confirmed') then raise exception 'Invalid order transition'; end if;
     o:=o||jsonb_build_object('status',expected);
   elsif p_action='finish' then
     if a is distinct from worker and not (p_kind='hospital' and public.kp_v8_role(a,'Помощник врача')) then raise exception 'Assigned worker required'; end if;
     expected:=case p_kind when 'hospital' then 'awaiting_confirmation' when 'taxi' then 'waiting_payment' else 'delivered' end;
     if o->>'status'=expected then return o; end if;
     if o->>'status'<>(case when p_kind='hospital' then 'accepted' else 'in_progress' end) then raise exception 'Service has not started'; end if;
     o:=o||jsonb_build_object('status',expected,'workerConfirmed',true,'doctorConfirmed',true);
   elsif p_action='confirm' then
     if a is distinct from o->>'client' then raise exception 'Client confirmation required'; end if;
     if o->>'status' in ('paid','done') then return o; end if;
     if o->>'status' not in ('waiting_payment','awaiting_confirmation','delivered') or worker is null then raise exception 'Worker must finish first'; end if;
     total:=coalesce((o->>'escrowAmount')::bigint,0);product_price:=coalesce((o->>'productPrice')::bigint,0);
     if total<>price+product_price then raise exception 'Escrow mismatch'; end if;
     if price>0 then perform public.kp_v8_money(worker,price,(md5(p_kind||p_id||':worker'))::uuid,'service_payout',jsonb_build_object('order',p_id));end if;
     if product_price>0 then perform public.kp_v8_money(o->>'supplier',product_price,(md5(p_kind||p_id||':product'))::uuid,'business_sale',jsonb_build_object('order',p_id));end if;
     o:=o||jsonb_build_object('status',case when p_kind='delivery' then 'done' else 'paid' end,'clientConfirmed',true,'clientReceived',true,'paymentStatus','paid','payoutDone',true,'escrowAmount',0,'paidAt',at_ms);
   else raise exception 'Unknown service action'; end if;
   o:=o||jsonb_build_object('updatedAt',at_ms);
 end if;
 orders:=jsonb_set(orders,array[p_id],o,true);
 if p_kind='hospital' then root:=jsonb_set(root,'{appointments}',orders,true);else root:=orders;end if;
 perform public.kp_v8_put(branch_name,root);
 if p_action<>'location' then
   perform public.kp_v8_notify(o->>'client',case p_kind when 'taxi' then 'Такси' when 'delivery' then 'Доставка' else 'Больница' end||': '||case p_action when 'create' then 'заказ создан, оплата зарезервирована' when 'cancel' then 'заказ отменён, оплата возвращена' when 'take' then 'исполнитель назначен' when 'start' then 'выполнение началось' when 'finish' then 'подтвердите получение услуги' else 'оплата завершена' end,'system',p_kind||'_'||p_id||'_'||p_action);
   if p_action in ('create','take') and o->>'worker' is not null then perform public.kp_v8_notify(o->>'worker','Новый заказ: '||case p_kind when 'taxi' then 'такси' when 'delivery' then 'доставка' else 'приём в больнице' end,'system',p_kind||'_'||p_id||'assigned');end if;
 end if;
 return o;
end; $$;
revoke all on function public.kp_v8_distance(numeric,numeric,numeric,numeric) from public,anon,authenticated;
revoke all on function public.kp_service_v8(text,text,text,jsonb) from public,anon;
grant execute on function public.kp_service_v8(text,text,text,jsonb) to authenticated;


-- ===== 011_messages_and_management.sql =====
create or replace function public.kp_message_v8(p_action text,p_kind text,p_peer text default null,p_id text default null,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); b text; conv text; path text[]; root jsonb; msg jsonb; users jsonb; attachment jsonb; reply jsonb; emoji text; target jsonb; idx jsonb; at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 if a is null or p_kind not in ('chat','dm') or coalesce(p_id,'')!~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'Invalid message request'; end if;
 if p_kind='dm' then
   if p_peer is null or not exists(select 1 from public.kp_profiles where nickname=p_peer) then raise exception 'Recipient missing'; end if;
   conv:=case when a collate "C" < p_peer collate "C" then a||'__dm__'||p_peer else p_peer||'__dm__'||a end;
   b:='dms';path:=array[conv,'messages',p_id];
 else b:='chat';path:=array[p_id];end if;
 select document into users from public.kp_tree_roots where branch='users';
 insert into public.kp_tree_roots(branch) values(b) on conflict do nothing;
 select document into root from public.kp_tree_roots where branch=b for update;
 msg:=root #> path;
 if p_action='send' then
   if msg is not null then
     if msg->>'nick'<>a then raise exception 'Message identifier collision'; end if;
     return msg;
   end if;
   if length(coalesce(p_data->>'text',''))>4000 or jsonb_typeof(coalesce(p_data->'attachments','[]'))<>'array' or jsonb_array_length(coalesce(p_data->'attachments','[]'))>6 then raise exception 'Message limit exceeded'; end if;
   for attachment in select value from jsonb_array_elements(coalesce(p_data->'attachments','[]')) loop
     if attachment->>'type' is null or attachment->>'type' not in ('image','video','voice','video_circle','sticker') or coalesce(attachment->>'url','')!~ '^https://' or length(attachment->>'url')>2000 then raise exception 'Invalid attachment'; end if;
   end loop;
   msg:=jsonb_build_object('nick',a,'avatar',users->a->>'avatar','text',left(coalesce(p_data->>'text',''),4000),'attachments',coalesce(p_data->'attachments','[]'),'createdAt',at_ms,'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI'));
   if p_data ? 'replyId' then
     reply:=root #> (case when p_kind='chat' then array[p_data->>'replyId'] else array[conv,'messages',p_data->>'replyId'] end);
     if reply is not null then msg:=msg||jsonb_build_object('reply',jsonb_build_object('id',p_data->>'replyId','nick',reply->>'nick','text',left(coalesce(reply->>'text','Вложение'),180)));end if;
   end if;
   if p_data ? 'forward' then
     target:=public.kp_tree_access('read',p_data->'forward'->>'path');reply:=target->'value';
     if (p_data->'forward'->>'path') !~ '^(chat/[^/]+|dms/[^/]+/messages/[^/]+)$' or reply is null or reply->>'nick' is null then raise exception 'Forwarded message unavailable'; end if;
     msg:=msg||jsonb_build_object('text',reply->>'text','attachments',coalesce(reply->'attachments',case when reply->>'mediaData' is not null then jsonb_build_array(jsonb_build_object('url',reply->>'mediaData','type',reply->>'msgType')) else '[]'::jsonb end),'forwardedFrom',reply->>'nick');
   end if;
   if coalesce(msg->>'text','')='' and jsonb_array_length(msg->'attachments')=0 then raise exception 'Empty message'; end if;
 elsif p_action='reaction' then
   if msg is null then raise exception 'Message missing'; end if;
   emoji:=p_data->>'emoji';if emoji not in ('👍','❤️','😂','🔥','😮','😢') then raise exception 'Unsupported reaction'; end if;
   target:=coalesce(msg->'reactions','{}');
   if target->>a=emoji then target:=target-a;else target:=jsonb_set(target,array[a],to_jsonb(emoji),true);end if;
   msg:=msg||jsonb_build_object('reactions',target);
 elsif p_action='edit' then
   if msg is null or msg->>'nick'<>a then raise exception 'Only author can edit'; end if;
   if length(trim(coalesce(p_data->>'text',''))) not between 1 and 4000 then raise exception 'Invalid message text';end if;
   msg:=msg||jsonb_build_object('text',trim(p_data->>'text'),'caption',trim(p_data->>'text'),'edited',true);
 elsif p_action='delete' then
   if msg is null then return jsonb_build_object('ok',true);end if;
   if msg->>'nick'<>a then raise exception 'Only author can delete'; end if;
   root:=root #- path;perform public.kp_v8_put(b,root);return jsonb_build_object('ok',true);
 else raise exception 'Unknown message action';end if;
 root:=public.kp_tree_set_deep(root,path,msg);perform public.kp_v8_put(b,root);
 if p_kind='dm' and p_action='send' then
   insert into public.kp_tree_roots(branch) values('dmIndex') on conflict do nothing;
   select document into idx from public.kp_tree_roots where branch='dmIndex' for update;
   target:=jsonb_build_object('lastTs',at_ms,'latest',msg);
   idx:=public.kp_tree_set_deep(idx,array[a,p_peer],target||'{"unread":false}');
   idx:=public.kp_tree_set_deep(idx,array[p_peer,a],target||'{"unread":true}');
   perform public.kp_v8_put('dmIndex',idx);
 end if;
 return msg;
end; $$;

-- Restricted editors for existing business, racing and hospital interfaces.
create or replace function public.kp_content_v8(p_operation text,p_path text,p_payload jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); p text[]:=string_to_array(p_path,'/');b text;d jsonb;old jsonb;v jsonb;k text;u jsonb;
begin
 if a is null then raise exception 'Authentication required';end if;
 b:=p[1];if p_operation not in ('set','update','remove') then raise exception 'Invalid operation';end if;
 select document->a into u from public.kp_tree_roots where branch='users' for update;
 insert into public.kp_tree_roots(branch) values(b) on conflict do nothing;
 select document into d from public.kp_tree_roots where branch=b for update;
 old:=d #> p[2:cardinality(p)];
 if b in ('races','raceDayGroups','rentBuildings') then
   if a<>'Кайон' or cardinality(p)<2 then raise exception 'Mayor access required';end if;
 elsif b='businesses' then
   if d->p[2]->>'owner' is distinct from a or cardinality(p)<2 then raise exception 'Business owner required';end if;
   if cardinality(p)=2 then
     if p_operation<>'update' then raise exception 'Only business details may be updated';end if;
     for k in select jsonb_object_keys(p_payload) loop
       if k ~ '^(products|roles)/[A-Za-z0-9_-]+$' then
         v:=p_payload->k;
         if k like 'products/%' and v<>'null'::jsonb and (v->>'price' is null or (v->>'price')::numeric not between 1 and 100000 or length(coalesce(v->>'name','')) not between 1 and 120) then raise exception 'Invalid product';end if;
         continue;
       end if;
       if k not in ('name','desc','address','lat','lng','category','services','icon','banner','delivery','bgEffect','description') then raise exception 'Protected business field: %',k;end if;
     end loop;
   elsif p[3] not in ('products','roles') or cardinality(p)<>4 then raise exception 'Protected business field';end if;
   if p[3]='products' and p_operation<>'remove' then
     v:=coalesce(old,'{}')||p_payload;
     if v->>'price' is null or (v->>'price')::numeric not between 1 and 100000 or length(coalesce(v->>'name','')) not between 1 and 120 then raise exception 'Invalid product';end if;
   end if;
 elsif b='hospital' then
   if not public.kp_v8_role(a,'Врач') or p[2] not in ('services','photos','assistantSalary') then raise exception 'Doctor access required';end if;
   if p[2]='services' and p_operation<>'remove' then
     v:=coalesce(old,'{}')||p_payload;
     if v->>'price' is null or (v->>'price')::numeric not between 0 and 10000 or length(coalesce(v->>'name','')) not between 1 and 120 then raise exception 'Invalid service';end if;
   end if;
 elsif b in ('janitorSubmissions','deputyProposals','atmRequests','bizDeleteRequests') then
   if cardinality(p)<>2 or p_operation<>'set' or old is not null then raise exception 'Use review service for existing requests';end if;
   if b='janitorSubmissions' and not public.kp_v8_role(a,'Уборщик') then raise exception 'Janitor access required';end if;
   if b='deputyProposals' and not public.kp_v8_role(a,'Депутат') then raise exception 'Deputy access required';end if;
   if b='bizDeleteRequests' and (select document->(p_payload->>'bizId')->>'owner' from public.kp_tree_roots where branch='businesses') is distinct from a then raise exception 'Business owner required';end if;
   if b='janitorSubmissions' and exists(select 1 from jsonb_each(d)e where e.value->>'worker'=a and e.value->>'date'=to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD') and e.value->>'status' in ('pending','approved')) then raise exception 'Today already submitted';end if;
   p_payload:=p_payload||jsonb_build_object('date',to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD'),'id',p[2],'from',a,'owner',a,'worker',a,'nick',a,'author',a,'status','pending','createdAt',(extract(epoch from now())*1000)::bigint);
 elsif b='bizComplaints' then
   if cardinality(p)<>3 then raise exception 'Choose one message';end if;
   if p_operation='set' and old is null then
     if length(trim(coalesce(p_payload->>'text',''))) not between 5 and 2000 then raise exception 'Message length 5 to 2000';end if;
     p_payload:=p_payload||jsonb_build_object('id',p[3],'from',a,'createdAt',(extract(epoch from now())*1000)::bigint);
   elsif p_operation='remove' and (old->>'from'=a or (select document->p[2]->>'owner' from public.kp_tree_roots where branch='businesses')=a) then null;
   else raise exception 'Message author or business owner required';end if;
 else raise exception 'Unsupported content branch';end if;
 if octet_length(coalesce(p_payload,'null')::text)>3000000 then raise exception 'Content too large';end if;
 if p_operation='remove' then d:=d #- p[2:cardinality(p)];v:=null;
 else
   v:=coalesce(old,'{}');
   if p_operation='update' then
     for k in select jsonb_object_keys(p_payload) loop
       if p_payload->k='null'::jsonb then v:=v #- string_to_array(k,'/');else v:=public.kp_tree_set_deep(v,string_to_array(k,'/'),p_payload->k);end if;
     end loop;
   else v:=p_payload;end if;
   d:=public.kp_tree_set_deep(d,p[2:cardinality(p)],v);
 end if;
 perform public.kp_v8_put(b,d);return jsonb_build_object('value',v,'committed',true);
end; $$;
create or replace function public.kp_business_application_v8(p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();apps jsonb;users jsonb;businesses jsonb;o jsonb;fee bigint:=2500;owner text;count_owned integer;ids jsonb;
begin
 if a is null or coalesce(p_id,'')!~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'Invalid application';end if;
 insert into public.kp_tree_roots(branch) values('users'),('businessApps'),('businesses') on conflict do nothing;
 select document into users from public.kp_tree_roots where branch='users' for update;
 select document into apps from public.kp_tree_roots where branch='businessApps' for update;
 select document into businesses from public.kp_tree_roots where branch='businesses' for update;
 o:=apps->p_id;
 if p_action='submit' then
   if o is not null then if o->>'owner'=a then return o;else raise exception 'Duplicate identifier';end if;end if;
   if coalesce(users->a->>'accountVerified','false')<>'true' or users->a->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if exists(select 1 from jsonb_each(apps)e where e.value->>'owner'=a and e.value->>'status'='pending') then raise exception 'An application is already pending';end if;
   select count(*) into count_owned from jsonb_each(businesses)e where e.value->>'owner'=a and e.value->>'status'='active';
   if count_owned>=3 then raise exception 'Maximum three active businesses';end if;
   if length(trim(coalesce(p_data->>'name',''))) not between 2 and 80 or length(trim(coalesce(p_data->>'desc',''))) not between 5 and 2000 or not public.kp_v8_point(p_data->>'lat',p_data->>'lng') then raise exception 'Complete the business application and map point';end if;
   perform public.kp_v8_money(a,-fee,(md5(p_id||':business-fee'))::uuid,'business_application');
   o:=jsonb_build_object('id',p_id,'owner',a,'name',trim(p_data->>'name'),'desc',p_data->>'desc','address',left(p_data->>'address',200),'lat',p_data->'lat','lng',p_data->'lng','category',left(p_data->>'category',80),'services',left(p_data->>'services',1000),'status','pending','feePaid',fee,'createdAt',(extract(epoch from now())*1000)::bigint);
 else
   if a<>'Кайон' or p_action not in ('approve','reject') or o is null then raise exception 'Mayor review required';end if;
   if o->>'status'<>'pending' then return o;end if;
   owner:=o->>'owner';
   if p_action='approve' then
     businesses:=jsonb_set(businesses,array[p_id],o||jsonb_build_object('status','active','balance',0,'delivery',false,'products','{}'::jsonb,'roles','{}'::jsonb,'employees','{}'::jsonb),true);
     perform public.kp_v8_put('businesses',businesses);
     ids:=coalesce(users->owner->'businessIds','[]');if not(ids ? p_id) then ids:=ids||to_jsonb(p_id);end if;
     select document into users from public.kp_tree_roots where branch='users';
     users:=jsonb_set(users,array[owner],(users->owner)||jsonb_build_object('businessIds',ids,'businessId',ids->>0));perform public.kp_v8_put('users',users);
   else perform public.kp_v8_money(owner,coalesce((o->>'feePaid')::bigint,0),(md5(p_id||':business-refund'))::uuid,'business_refund');end if;
   o:=o||jsonb_build_object('status',case when p_action='approve' then 'approved' else 'rejected' end);
 end if;
 apps:=jsonb_set(apps,array[p_id],o,true);perform public.kp_v8_put('businessApps',apps);return o;
end; $$;
revoke all on function public.kp_message_v8(text,text,text,text,jsonb),public.kp_content_v8(text,text,jsonb),public.kp_business_application_v8(text,text,jsonb) from public,anon;
grant execute on function public.kp_message_v8(text,text,text,text,jsonb),public.kp_content_v8(text,text,jsonb),public.kp_business_application_v8(text,text,jsonb) to authenticated;


-- ===== 012_hospital_and_business.sql =====
create or replace function public.kp_hospital_view() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();d jsonb;apps jsonb;assistant_apps jsonb;staff boolean;
begin
 if a is null then raise exception 'Authentication required';end if;
 select document into d from public.kp_tree_roots where branch='hospital';d:=coalesce(d,'{}');
 staff:=a='Кайон' or public.kp_v8_role(a,'Врач') or public.kp_v8_role(a,'Помощник врача');
 select coalesce(jsonb_object_agg(key,value),'{}') into apps from jsonb_each(coalesce(d->'appointments','{}')) where staff or value->>'clientNick'=a;
 select coalesce(jsonb_object_agg(key,value),'{}') into assistant_apps from jsonb_each(coalesce(d->'assistantApplications','{}')) where staff or value->>'from'=a;
 return jsonb_build_object('services',coalesce(d->'services','{}'),'photos',coalesce(d->'photos','{}'),'appointments',apps,'assistantApplications',assistant_apps,'assistantSalary',case when staff then coalesce(d->'assistantSalary','0') else '0'::jsonb end);
end; $$;
create or replace function public.kp_v8_notify(n text,t text,kind text,key text) returns void language plpgsql security definer set search_path='' as $$
declare d jsonb;at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 select document into d from public.kp_tree_roots where branch='users' for update;
 if d->n is null then return;end if;
 d:=public.kp_tree_set_deep(d,array[n,'notifications',key],jsonb_build_object('id',key,'text',left(t,500),'type',kind,'read',false,'seen',false,'createdAt',at_ms,'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI')));
 perform public.kp_v8_put('users',d);
end; $$;
create or replace function public.kp_employment_v8(p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();u jsonb;root jsonb;b jsonb;app jsonb;apps jsonb;jobs jsonb;target text;role_id text;role_name text;branch_name text;path text[];limit_jobs integer;at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 if a is null or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid employment request';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 branch_name:=case when p_data->>'kind'='assistant' then 'hospital' else 'bizJobApps' end;
 insert into public.kp_tree_roots(branch) values(branch_name) on conflict do nothing;
 select document into root from public.kp_tree_roots where branch=branch_name for update;
 if branch_name='hospital' then
   path:=array['assistantApplications',p_id];role_name:='Помощник врача';
 else
   select document->(p_data->>'bizId') into b from public.kp_tree_roots where branch='businesses' for update;
   if b is null or b->>'status'<>'active' then raise exception 'Business unavailable';end if;
   path:=array[p_data->>'bizId',p_id];
 end if;
 app:=root #> path;
 if p_action='apply' then
   if app is not null then if app->>'from'=a then return app;else raise exception 'Duplicate application';end if;end if;
   if coalesce(u->a->>'accountVerified','false')<>'true' or u->a->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if exists(select 1 from jsonb_each(coalesce(root->path[1],'{}')) e where coalesce(e.value->>'from',e.value->>'applicant')=a and e.value->>'status'='pending') then raise exception 'Application already pending';end if;
   role_id:=p_data->>'roleId';
   if branch_name='hospital' then
     if coalesce((u->a->>'kveScore')::integer,0)<80 then raise exception 'KVE score 80 required';end if;
   else
     if b->>'owner'=a or b->'roles'->role_id is null then raise exception 'Select a vacancy';end if;
     role_name:=b->'roles'->role_id->>'name';
   end if;
   app:=jsonb_build_object('id',p_id,'from',a,'applicant',a,'bizId',p_data->>'bizId','roleId',role_id,'roleName',role_name,'text',left(coalesce(p_data->>'text',''),1200),'status','pending','createdAt',at_ms);
 else
   if branch_name='hospital' then
     if not public.kp_v8_role(a,'Врач') then raise exception 'Doctor access required';end if;
   elsif a is distinct from b->>'owner' and p_action<>'quit' then raise exception 'Business owner required';end if;
   if p_action in ('approve','reject') then
     if app is null then raise exception 'Application missing';end if;
     if app->>'status'<>'pending' then return app;end if;
     target:=coalesce(app->>'from',app->>'applicant');role_id:=app->>'roleId';role_name:=app->>'roleName';
   else target:=case when p_action='quit' then a else p_data->>'target' end;end if;
   jobs:=coalesce(u->target->'employments','[]');
   if p_action='approve' then
     limit_jobs:=case when coalesce((u->target->>'subscriptionExpiry')::timestamptz,now())>now() then case u->target->>'subscription' when 'plus' then 3 when 'ultra' then 4 when 'prime' then 5 else 2 end else 2 end;
     if jsonb_array_length(jobs)>=limit_jobs then raise exception 'Employment limit reached';end if;
     if branch_name='hospital' then
       if exists(select 1 from jsonb_each(u)e where public.kp_v8_role(e.key,'Помощник врача')) or coalesce((u->target->>'kveScore')::integer,0)<80 then raise exception 'Assistant unavailable';end if;
       jobs:=jobs||jsonb_build_array(jsonb_build_object('id','muni_Помощник врача','type','municipal','role','Помощник врача'));
     else
       if b->'roles'->role_id is null or b->'employees' ? target or (select count(*) from jsonb_object_keys(coalesce(b->'employees','{}')))>=coalesce((b->>'employeeLimit')::integer,5) then raise exception 'Vacancy unavailable';end if;
       b:=public.kp_tree_set_deep(b,array['employees',target],jsonb_build_object('roleId',role_id,'roleName',role_name,'joinedAt',at_ms));
       jobs:=jobs||jsonb_build_array(jsonb_build_object('id','biz_'||(p_data->>'bizId'),'type','business','bizId',p_data->>'bizId','bizName',b->>'name','role',role_name));
     end if;
     u:=jsonb_set(u,array[target],(u->target)||jsonb_build_object('employments',jobs,'displayJob',role_name)||case when branch_name='hospital' then jsonb_build_object('job','Помощник врача') else '{}'::jsonb end);
   elsif p_action in ('fire','quit') and branch_name<>'hospital' then
     if b->'employees'->target is null then raise exception 'Employee missing';end if;
     b:=b #- array['employees',target];
     select coalesce(jsonb_agg(value),'[]') into jobs from jsonb_array_elements(jobs) where value->>'bizId' is distinct from p_data->>'bizId';
     u:=jsonb_set(u,array[target],(u->target)||jsonb_build_object('employments',jobs,'displayJob',coalesce(jobs->0->>'role','Житель'),'employerBizId',null));
   elsif p_action<>'reject' then raise exception 'Unsupported employment action';end if;
   if p_action<>'reject' then perform public.kp_v8_put('users',u);end if;
   if branch_name<>'hospital' then
     select document into apps from public.kp_tree_roots where branch='businesses';perform public.kp_v8_put('businesses',jsonb_set(apps,array[p_data->>'bizId'],b));
   end if;
   app:=coalesce(app,'{}')||jsonb_build_object('status',case when p_action='approve' then 'approved' when p_action='reject' then 'rejected' else 'closed' end,'reviewedAt',at_ms);
   perform public.kp_v8_notify(target,'Заявка на работу: '||case when p_action='approve' then 'одобрена' when p_action='reject' then 'отклонена' else 'работа завершена' end,'system','employment_'||p_id||p_action);
 end if;
 if p_action='apply' then
   if branch_name='hospital' then select key into target from jsonb_each(u)e where public.kp_v8_role(e.key,'Врач') order by key limit 1;else target:=b->>'owner';end if;
   perform public.kp_v8_notify(target,'Новая заявка на работу от '||a,'system','employment_'||p_id);
 end if;
 root:=public.kp_tree_set_deep(root,path,app);perform public.kp_v8_put(branch_name,root);return app;
end; $$;
create or replace function public.kp_business_order_v8(p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();u jsonb;b jsonb;root jsonb;o jsonb;items jsonb:='[]';entry record;product jsonb;qty integer;total bigint:=0;owner text;at_ms bigint:=(extract(epoch from now())*1000)::bigint;bid text:=p_data->>'bizId';
begin
 if a is null or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid order';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 select document->bid into b from public.kp_tree_roots where branch='businesses' for update;
 if b is null then raise exception 'Business missing';end if;owner:=b->>'owner';
 insert into public.kp_tree_roots(branch) values('bizOrders') on conflict do nothing;
 select document into root from public.kp_tree_roots where branch='bizOrders' for update;o:=root->bid->p_id;
 if p_action='create' then
   if o is not null then if o->>'client'=a then return o;else raise exception 'Request mismatch';end if;end if;
   if b->>'status'<>'active' or owner=a or coalesce(u->a->>'accountVerified','false')<>'true' or u->a->>'accountFrozen'='true' then raise exception 'Purchase unavailable';end if;
   if coalesce(jsonb_typeof(p_data->'cart'),'null')<>'object' or (select count(*) from jsonb_object_keys(p_data->'cart')) not between 1 and 30 then raise exception 'Invalid cart';end if;
   for entry in select key,value from jsonb_each(p_data->'cart') loop
     qty:=(entry.value#>>'{}')::integer;product:=b->'products'->entry.key;
     if qty is null or qty not between 1 and 20 or product is null or product->>'available'='false' or product->>'price' is null or (product->>'price')::numeric not between 1 and 100000 then raise exception 'Product unavailable';end if;
     total:=total+qty*(product->>'price')::bigint;
     items:=items||jsonb_build_array(jsonb_build_object('productId',entry.key,'name',product->>'name','qty',qty,'price',(product->>'price')::bigint,'total',qty*(product->>'price')::bigint));
   end loop;
   if total>100000 then raise exception 'Order limit 100000';end if;
   perform public.kp_v8_money(a,-total,(md5(p_id||':biz-reserve'))::uuid,'business_order_reserve',jsonb_build_object('bizId',bid));
   o:=jsonb_build_object('id',p_id,'bizId',bid,'bizName',b->>'name','client',a,'clientNick',a,'owner',owner,'items',items,'total',total,'amount',total,'status','paid_waiting_receipt','escrowAmount',total,'clientConfirmed',false,'ownerConfirmed',false,'createdAt',at_ms);
 elsif p_action='confirm' then
   if o is null or (a is distinct from o->>'client' and a<>owner) then raise exception 'Order participant required';end if;
   if o->>'status'='completed' then return o;end if;
   if o->>'status'<>'paid_waiting_receipt' then raise exception 'Invalid order state';end if;
   o:=o||case when a=owner then '{"ownerConfirmed":true}'::jsonb else '{"clientConfirmed":true}'::jsonb end;
   if o->>'ownerConfirmed'='true' and o->>'clientConfirmed'='true' then
     perform public.kp_v8_money(owner,(o->>'escrowAmount')::bigint,(md5(p_id||':biz-paid'))::uuid,'business_sale',jsonb_build_object('bizId',bid));
     o:=o||jsonb_build_object('status','completed','escrowAmount',0,'payoutDone',true,'paidAt',at_ms);
   end if;
 elsif p_action='cancel' then
   if o is null or a is distinct from o->>'client' then raise exception 'Client required';end if;
   if o->>'status'='cancelled' then return o;end if;
   if o->>'status'<>'paid_waiting_receipt' or o->>'ownerConfirmed'='true' then raise exception 'Order already handed over';end if;
   perform public.kp_v8_money(a,(o->>'escrowAmount')::bigint,(md5(p_id||':biz-refund'))::uuid,'business_order_refund');o:=o||'{"status":"cancelled","escrowAmount":0}';
 else raise exception 'Unknown order action';end if;
 root:=public.kp_tree_set_deep(root,array[bid,p_id],o);perform public.kp_v8_put('bizOrders',root);
 perform public.kp_v8_notify(case when a=owner then o->>'client' else owner end,'Заказ в «'||(b->>'name')||'»: '||case when p_action='create' then 'новый заказ' when p_action='cancel' then 'отменён' else 'получение подтверждено' end,'system','bizorder_'||p_id||p_action||a);
 return o;
end; $$;
revoke all on function public.kp_v8_notify(text,text,text,text) from public,anon,authenticated;
revoke all on function public.kp_employment_v8(text,text,jsonb),public.kp_business_order_v8(text,text,jsonb) from public,anon;
grant execute on function public.kp_employment_v8(text,text,jsonb),public.kp_business_order_v8(text,text,jsonb) to authenticated;


-- ===== 013_civic_and_finance.sql =====
create table if not exists public.kp_v8_finance_ops(id uuid primary key,actor text not null,args jsonb not null,result jsonb not null,created_at timestamptz default now());
alter table public.kp_v8_finance_ops enable row level security;
revoke all on public.kp_v8_finance_ops from anon,authenticated;
create or replace function public.kp_business_finance_v8(p_action text,p_id uuid,p_biz text default null,p_amount bigint default 0,p_target text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();d jsonb;u jsonb;b jsonb;bal bigint;args jsonb;result jsonb;old public.kp_v8_finance_ops%rowtype;receiver text;
begin
 if a is null or p_id is null or p_amount is null or p_amount not between 1 and 100000 then raise exception 'Amount must be 1 to 100000';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 args:=jsonb_build_object('action',p_action,'biz',p_biz,'amount',p_amount,'target',p_target);
 select * into old from public.kp_v8_finance_ops where id=p_id;
 if found then if old.actor<>a or old.args<>args then raise exception 'Request mismatch';end if;return old.result;end if;
 if coalesce(u->a->>'accountFrozen','false')='true' then raise exception 'Account frozen';end if;
 if p_action='assistant_salary' then
   if not public.kp_v8_role(a,'Врач') or not public.kp_v8_role(p_target,'Помощник врача') then raise exception 'Doctor and assistant required';end if;
   perform public.kp_v8_money(a,-p_amount,p_id,'assistant_salary_out');
   perform public.kp_v8_money(p_target,p_amount,(md5(p_id::text||':salary'))::uuid,'assistant_salary_in');bal:=null;
 else
   select document into d from public.kp_tree_roots where branch='businesses' for update;b:=d->p_biz;
   if b is null or b->>'owner' is distinct from a or b->>'status'<>'active' then raise exception 'Active business owner required';end if;
   bal:=coalesce((b->>'balance')::bigint,0);
   if p_action='deposit' then
     perform public.kp_v8_money(a,-p_amount,p_id,'business_deposit',jsonb_build_object('bizId',p_biz));bal:=bal+p_amount;
   elsif p_action in ('withdraw','salary') then
     if bal<p_amount then raise exception 'Insufficient business funds';end if;
     receiver:=case when p_action='withdraw' then a else p_target end;
     if p_action='salary' and (p_target is null or b->'employees'->p_target is null) then raise exception 'Employee required';end if;
     perform public.kp_v8_money(receiver,p_amount,p_id,'business_'||p_action,jsonb_build_object('bizId',p_biz));bal:=bal-p_amount;
   else raise exception 'Unknown business operation';end if;
   b:=b||jsonb_build_object('balance',bal);perform public.kp_v8_put('businesses',jsonb_set(d,array[p_biz],b));
 end if;
 result:=jsonb_build_object('ok',true,'balance',bal);
 insert into public.kp_v8_finance_ops(id,actor,args,result)values(p_id,a,args,result);
 if p_target is not null then perform public.kp_v8_notify(p_target,'Получена зарплата: '||p_amount||' ₽','money','salary_'||p_id::text);end if;
 return result;
end; $$;

-- All civic requests have one durable, reviewable record. Protected rewards
-- are paid once; changing status alone never mints money.
create or replace function public.kp_civic_v8(p_action text,p_kind text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();u jsonb;d jsonb;o jsonb;l jsonb;b jsonb;branch_name text;target text;fee bigint:=0;accepted boolean;at_ms bigint:=(extract(epoch from now())*1000)::bigint;op uuid;score integer;
begin
 if a is null or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid civic request';end if;
 branch_name:=case p_kind when 'janitor' then 'janitorSubmissions' when 'police' then 'policeRequests' when 'business_close' then 'bizDeleteRequests' else 'civicRequests' end;
 if p_kind not in ('janitor','police','business_close','education','bike','scooter') then raise exception 'Unknown request kind';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 insert into public.kp_tree_roots(branch)values(branch_name),('licenses') on conflict do nothing;
 select document into d from public.kp_tree_roots where branch=branch_name for update;o:=d->p_id;
 if p_action='submit' then
   if o is not null then if o->>'from'=a or o->>'worker'=a then return o;else raise exception 'Request mismatch';end if;end if;
   if coalesce(u->a->>'accountVerified','false')<>'true' or u->a->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if exists(select 1 from jsonb_each(d)e where coalesce(e.value->>'from',e.value->>'worker')=a and coalesce(e.value->>'kind',p_kind)=p_kind and e.value->>'status'='pending') then raise exception 'Request already pending';end if;
   if p_kind in ('bike','scooter') then
     select document into l from public.kp_tree_roots where branch='licenses' for update;
     if l->a->>p_kind='true' then raise exception 'License already issued';end if;
     fee:=case when p_kind='bike' then 250 else 1500 end;
   elsif p_kind='education' then
     if u->a->'kEducationPurchase'->>'status' in ('paid','submitted','approved') then raise exception 'Education already paid';end if;fee:=2000;
   elsif p_kind='janitor' then
     if not public.kp_v8_role(a,'Уборщик') or length(coalesce(p_data->>'photo',''))<10 then raise exception 'Janitor and proof photo required';end if;
     if exists(select 1 from jsonb_each(d)e where e.value->>'worker'=a and e.value->>'date'=to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD') and e.value->>'status' in ('pending','approved')) then raise exception 'Today already submitted';end if;
   elsif p_kind='police' then
     if not(public.kp_v8_role(a,'КСБ') or public.kp_v8_role(a,'Полицейский')) or length(trim(coalesce(p_data->>'reason','')))<5 or u->(p_data->>'target') is null then raise exception 'Officer and valid request required';end if;
     if p_data->>'type' not in ('fine','freeze') then raise exception 'Only fine or freeze requests';end if;
     if p_data->>'type'='fine' and (p_data->>'amount' is null or (p_data->>'amount')::bigint not between 1 and 10000) then raise exception 'Fine must be 1 to 10000';end if;
   elsif p_kind='business_close' then
     select document->(p_data->>'bizId') into b from public.kp_tree_roots where branch='businesses';
     if b->>'owner' is distinct from a then raise exception 'Business owner required';end if;
   end if;
   if fee>0 then perform public.kp_v8_money(a,-fee,(md5(p_id||':civic-fee'))::uuid,'civic_fee',jsonb_build_object('kind',p_kind));end if;
   o:=jsonb_build_object('id',p_id,'kind',p_kind,'from',a,'worker',a,'officer',a,'owner',a,'status',case when p_kind='bike' then 'approved' else 'pending' end,'createdAt',at_ms,'feePaid',fee,'date',to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD'),'comment',left(coalesce(p_data->>'comment',''),1200),'photo',left(coalesce(p_data->>'photo',''),2500000),'target',p_data->>'target','type',p_data->>'type','amount',p_data->'amount','reason',left(coalesce(p_data->>'reason',''),1200),'bizId',p_data->>'bizId');
   select document into u from public.kp_tree_roots where branch='users';
   if p_kind='bike' then perform public.kp_v8_put('licenses',public.kp_tree_set_deep(l,array[a,'bike'],'true'));
   elsif p_kind='scooter' then u:=public.kp_tree_set_deep(u,array[a,'scooterLicenseApplication'],o);
   elsif p_kind='education' then u:=public.kp_tree_set_deep(u,array[a,'kEducationPurchase'],o||'{"status":"submitted"}');
   elsif p_kind='janitor' then u:=jsonb_set(u,array[a],(u->a)||jsonb_build_object('janitorSubmissionId',p_id,'janitorSubmissionStatus','pending'));end if;
   perform public.kp_v8_put('users',u);
 else
   if a<>'Кайон' or p_action not in ('approve','reject') or o is null then raise exception 'Mayor review required';end if;
   if o->>'status'<>'pending' then return o;end if;
   target:=coalesce(o->>'from',o->>'worker',o->>'owner',o->>'officer');accepted:=p_action='approve';op:=(md5(p_id||':civic-review'))::uuid;
   if p_kind='janitor' and accepted then
     perform public.kp_v8_money(target,500,op,'janitor_reward',jsonb_build_object('request',p_id));
   elsif p_kind='police' and accepted then
     if o->>'type'='fine' then perform public.kp_mayor_fine(o->>'target',(o->>'amount')::bigint,o->>'reason',op);
     else u:=public.kp_tree_set_deep(u,array[o->>'target','accountFrozen'],'true');perform public.kp_v8_put('users',u);end if;
   elsif p_kind='business_close' and accepted then
     select document into b from public.kp_tree_roots where branch='businesses' for update;
     -- Archive instead of deleting orders, staff or financial history.
     b:=public.kp_tree_set_deep(b,array[o->>'bizId','status'],'"archived"');perform public.kp_v8_put('businesses',b);
   elsif p_kind='scooter' and accepted then
     select document into l from public.kp_tree_roots where branch='licenses' for update;perform public.kp_v8_put('licenses',public.kp_tree_set_deep(l,array[target,'scooter'],'true'));
   elsif p_kind in ('education','scooter') and not accepted then
     fee:=coalesce((o->>'feePaid')::bigint,0);if fee>0 then perform public.kp_v8_money(target,fee,op,'civic_refund');end if;
   end if;
   o:=o||jsonb_build_object('status',case when accepted then 'approved' else 'rejected' end,'reviewedAt',at_ms,'adminComment',left(coalesce(p_data->>'comment',''),500));
   select document into u from public.kp_tree_roots where branch='users';
   if p_kind='education' then u:=public.kp_tree_set_deep(u,array[target,'kEducationPurchase'],o);
   elsif p_kind='scooter' then u:=public.kp_tree_set_deep(u,array[target,'scooterLicenseApplication'],o);
   elsif p_kind='janitor' then u:=jsonb_set(u,array[target],(u->target)||jsonb_build_object('janitorSubmissionStatus',o->>'status'));end if;
   perform public.kp_v8_put('users',u);
 end if;
 d:=jsonb_set(d,array[p_id],o,true);perform public.kp_v8_put(branch_name,d);
 perform public.kp_v8_notify(case when p_action='submit' then 'Кайон' else target end,'Заявка: '||case p_kind when 'education' then 'К-образование' when 'scooter' then 'права на скутер' when 'bike' then 'права на велосипед' when 'janitor' then 'отчёт уборщика' when 'police' then 'обращение полиции' else 'закрытие бизнеса' end||' — '||case when p_action='submit' then 'поступила' when p_action='approve' then 'одобрена' else 'отклонена' end,'system','civic_'||p_id||p_action);
 return o;
end; $$;
revoke all on function public.kp_business_finance_v8(text,uuid,text,bigint,text),public.kp_civic_v8(text,text,text,jsonb) from public,anon;
grant execute on function public.kp_business_finance_v8(text,uuid,text,bigint,text),public.kp_civic_v8(text,text,text,jsonb) to authenticated;
