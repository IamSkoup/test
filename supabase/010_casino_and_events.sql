begin;
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
commit;
