-- Additional guarded operations for a migrated Kapani client.
-- Run after 001_tree_bridge.sql. Existing financial tables are preserved.
begin;

create or replace function public.kp_public_profiles()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_object_agg(p.nickname,jsonb_build_object(
    'nick',p.nickname,
    'displayName',left(coalesce(r.document->p.nickname->>'displayName',p.nickname),60)
  )),'{}'::jsonb)
  from public.kp_profiles p
  left join public.kp_tree_roots r on r.branch='users';
$$;
revoke all on function public.kp_public_profiles() from public;
grant execute on function public.kp_public_profiles() to anon,authenticated;

-- Legacy Supabase users may have an Auth identity and a protected wallet but
-- no JSON document after the Firebase-to-Supabase migration. Only the actual
-- authenticated owner may initialize that missing document. Never replace an
-- existing document and never accept a nickname or balance from the browser.
create or replace function public.kp_ensure_my_profile()
returns jsonb language plpgsql security definer set search_path='' as $$
declare nick text; whole jsonb; rev bigint; wallet_balance bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile not found'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots where branch='users' for update;
  if whole ? nick then
    return jsonb_build_object('created',false,'nick',nick);
  end if;
  select balance into wallet_balance from public.kp_wallets where user_id=auth.uid();
  whole:=jsonb_set(whole,array[nick],jsonb_build_object(
    'nick',nick,
    'displayName',nick,
    'balance',coalesce(wallet_balance,0),
    'taskBalance',0,
    'job','Житель',
    'avatar','',
    'notifications','{}'::jsonb,
    'settings','{}'::jsonb,
    'accountVerified',false,
    'accountFrozen',false,
    'createdAt',(extract(epoch from now())*1000)::bigint,
    'joinDate',to_char(now(),'DD.MM.YYYY')
  ),true);
  update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('created',true,'nick',nick);
end;
$$;
revoke all on function public.kp_ensure_my_profile() from public,anon;
grant execute on function public.kp_ensure_my_profile() to authenticated;

create or replace function public.kp_manage_notifications(
  p_action text, p_notification_id text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare nick text; whole jsonb; rev bigint; inbox jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile not found'; end if;
  if p_action not in ('delete','clear') then raise exception 'Unknown notification action'; end if;
  if p_action='delete' and (p_notification_id is null or length(p_notification_id) not between 1 and 120)
    then raise exception 'Invalid notification identifier'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots where branch='users' for update;
  inbox:=coalesce(whole->nick->'notifications','{}'::jsonb);
  if p_action='clear' then
    whole:=jsonb_set(whole,array[nick,'notifications'],'{}'::jsonb,true);
  else
    whole:=whole #- array[nick,'notifications',p_notification_id];
  end if;
  update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'removed',case when p_action='clear'
    then (select count(*) from jsonb_object_keys(inbox)) else 1 end);
end;
$$;
revoke all on function public.kp_manage_notifications(text,text) from public,anon;
grant execute on function public.kp_manage_notifications(text,text) to authenticated;

create or replace function public.kp_profile_patch(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  nick text; whole jsonb; profile jsonb; rev bigint; k text; v jsonb;
  active_subscription boolean; prime_subscription boolean; val text;
  editable constant text[]:=array[
    'displayName','avatar','avatarUrl','photoURL','profileDescription',
    'bio','about','status','lastSeen','online','lastActive','isOnline',
    'vehicle','nicknameEmoji','avatarFrame','profileBgEffect',
    'profileCustomBg','chatBubbleStyle','settings'
  ];
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile not found'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object'
    or (select count(*) from jsonb_object_keys(p_patch)) not between 1 and 18
    or pg_column_size(p_patch)>650000 then raise exception 'Invalid profile changes'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots where branch='users' for update;
  profile:=whole->nick;
  if profile is null then raise exception 'User data unavailable'; end if;
  active_subscription := coalesce(profile->>'subscription','none') <> 'none'
     and coalesce((profile->>'subscriptionExpiry')::timestamptz,now()-interval '1 day')>now();
  prime_subscription := active_subscription and profile->>'subscription'='prime';
  for k,v in select key,value from jsonb_each(p_patch) loop
    if not (k=any(editable)) then raise exception 'Protected account field: %',k; end if;
    if v is not null and jsonb_typeof(v)<>'null' and k<>'settings'
       and ((k in ('online','isOnline') and jsonb_typeof(v)<>'boolean')
         or (k in ('lastSeen','lastActive') and jsonb_typeof(v)<>'number')
         or (k not in ('online','isOnline','lastSeen','lastActive') and jsonb_typeof(v)<>'string')) then
       raise exception 'Invalid profile field type: %',k;
    end if;
    val:=coalesce(v #>> '{}','');
    if k='displayName' then
      if length(trim(val)) not between 2 and 40 then raise exception 'Name must be 2 to 40 characters'; end if;
      if exists(select 1 from jsonb_each(whole) as other(name,doc)
                where other.name<>nick and lower(trim(coalesce(other.doc->>'displayName',other.name)))=lower(trim(val)))
        or exists(select 1 from public.kp_profiles p where p.nickname<>nick and lower(p.nickname)=lower(trim(val)))
      then raise exception 'Display name already taken'; end if;
      v:=to_jsonb(trim(val));
    elsif k in ('avatar','avatarUrl','photoURL') then
      if length(val)>600000 or (val<>'' and val !~ '^https://[^[:space:]]+$'
           and val !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')
        then raise exception 'Unsupported avatar image'; end if;
    elsif k='profileCustomBg' then
      if val<>'' and (not prime_subscription or length(val)>240000
          or val !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$')
        then raise exception 'Custom cover requires active Prime'; end if;
    elsif k in ('nicknameEmoji','chatBubbleStyle','profileBgEffect') then
      if length(val)>64 or (val<>'' and not active_subscription) then
        raise exception 'Active subscription required for this customization'; end if;
      if k='profileBgEffect' and val='custom' and not prime_subscription then
        raise exception 'Custom profile cover requires Prime'; end if;
    elsif k='avatarFrame' then
      if length(val)>64 or (val<>'' and (not active_subscription
          or profile->>'subscription' not in ('ultra','prime'))) then
        raise exception 'Ultra or Prime subscription required for frames'; end if;
    elsif k='settings' then
      if jsonb_typeof(v)<>'object' or pg_column_size(v)>10000 then
        raise exception 'Invalid settings'; end if;
    elsif k in ('lastSeen','lastActive') then
      if (val::numeric)>extract(epoch from now())*1000+300000 or (val::numeric)<0 then
        raise exception 'Invalid activity timestamp'; end if;
    elsif k='profileDescription' then
      if length(val)>200 then raise exception 'Profile description too long'; end if;
    elsif k in ('bio','about') then
      if length(val)>500 then raise exception 'Profile text too long'; end if;
    elsif k='vehicle' then
      if length(val)>80 then raise exception 'Vehicle name too long'; end if;
    elsif length(val)>160 then raise exception 'Profile field too long';
    end if;
    profile:=jsonb_set(profile,array[k],coalesce(v,'null'::jsonb),true);
  end loop;
  whole:=jsonb_set(whole,array[nick],profile,true);
  update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'revision',rev+1);
end;
$$;
revoke all on function public.kp_profile_patch(jsonb) from public,anon;
grant execute on function public.kp_profile_patch(jsonb) to authenticated;

-- Task completion and withdrawal are kept inside a single database transaction.
-- Rewards and eligibility are looked up server-side; client-supplied amounts are ignored.
create or replace function public.kp_claim_task(p_kind text,p_task_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  nick text; whole jsonb; profile jsonb; rev bigint; reward integer:=0;
  day_key text; day_start bigint; day_end bigint; claimed_key text; claimed jsonb;
  task_names text[]:=array['chat','wall','transfer','shop','taxi_req','market_browse','dm'];
  prime_names text[]:=array['prime_listing','prime_transfer_big','prime_taxi2',
      'prime_chat5','prime_dm3','prime_shop_big'];
  task_rewards integer[]:=array[10,10,15,20,20,5,10];
  prime_rewards integer[]:=array[60,70,90,50,65,80];
  seed integer; n integer; i integer; j integer; swap text;
  allowed_today boolean:=false; proof boolean:=false; recent_count integer:=0;
  root_doc jsonb; item jsonb; message jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile not found'; end if;
  if length(coalesce(p_task_id,''))>60 then raise exception 'Invalid task identifier'; end if;
  day_key:=to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD');
  day_start:=(extract(epoch from (day_key::date::timestamp at time zone 'Europe/Moscow'))*1000)::bigint;
  day_end:=(extract(epoch from ((day_key::date+1)::timestamp at time zone 'Europe/Moscow'))*1000)::bigint;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots where branch='users' for update;
  profile:=whole->nick;
  if profile is null then raise exception 'Profile data missing'; end if;
  if coalesce((profile->>'roles')::jsonb->>'migrant','false')='true' then
    raise exception 'Tasks are not available for this account'; end if;
  if p_kind='daily' then
    claimed_key:='dailyClaimed_'||day_key;
    claimed:=coalesce(profile->claimed_key,'[]'::jsonb);
    if jsonb_typeof(claimed)<>'array' then claimed:='[]'::jsonb; end if;
    if claimed ? p_task_id then return jsonb_build_object('claimed',false,'reason','already claimed'); end if;
    n:=array_length(task_names,1);
    seed:=(to_char(day_key::date,'YYYYMMDD')::integer % 997);
    for i in reverse n..2 loop
      j:=((seed*i+(i-1)*37)%n)+1;
      swap:=task_names[i];task_names[i]:=task_names[j];task_names[j]:=swap;
    end loop;
    allowed_today:=p_task_id=any(task_names[1:3]);
    if not allowed_today then
      if profile->>'subscription'='prime' and
        coalesce((profile->>'subscriptionExpiry')::timestamptz,now()-interval '1 day')>now() then
        n:=array_length(prime_names,1);
        seed:=((to_char(day_key::date,'YYYYMMDD')::integer*31)%991);
        for i in reverse n..2 loop
          j:=((seed*i+(i-1)*53)%n)+1;
          swap:=prime_names[i];prime_names[i]:=prime_names[j];prime_names[j]:=swap;
        end loop;
        allowed_today:=p_task_id=any(prime_names[1:2]);
      end if;
    end if;
    if not allowed_today then raise exception 'Task is not active today'; end if;
    if p_task_id=any(array['chat','wall','dm','market_browse']) then
      reward:=case p_task_id when 'chat' then 10 when 'wall' then 10
               when 'dm' then 10 when 'market_browse' then 5 end;
    elsif p_task_id in ('prime_chat5','prime_dm3') then
      reward:=case p_task_id when 'prime_chat5' then 50 else 65 end;
    else
      raise exception 'This task requires a migrated server-side payment/order service';
    end if;
    if p_task_id='market_browse' then
      proof:=true;
    elsif p_task_id in ('chat','prime_chat5') then
      select count(*) into recent_count from public.kp_tree_roots r,
          jsonb_each(coalesce(r.document,'{}'::jsonb)) m
        where r.branch='chat' and m.value->>'nick'=nick
          and (case when m.value->>'createdAt' ~ '^[0-9]{13}$'
                    then (m.value->>'createdAt')::bigint else 0 end) >= day_start
          and (case when m.value->>'createdAt' ~ '^[0-9]{13}$'
                    then (m.value->>'createdAt')::bigint else 0 end) < day_end;
      proof:=recent_count >= case when p_task_id='prime_chat5' then 5 else 1 end;
    elsif p_task_id='wall' then
      select count(*) into recent_count from public.kp_tree_roots r,
          jsonb_each(coalesce(r.document->nick,'{}'::jsonb)) m
        where r.branch='walls'
          and (case when m.value->>'createdAt' ~ '^[0-9]{13}$'
                    then (m.value->>'createdAt')::bigint else 0 end) >= day_start
          and (case when m.value->>'createdAt' ~ '^[0-9]{13}$'
                    then (m.value->>'createdAt')::bigint else 0 end) < day_end;
      proof:=recent_count>0;
    elsif p_task_id in ('dm','prime_dm3') then
      select count(*) into recent_count from public.kp_tree_roots r,
         jsonb_each(coalesce(r.document,'{}'::jsonb)) conversation,
         jsonb_each(coalesce(conversation.value->'messages','{}'::jsonb)) m
        where r.branch='dms' and (split_part(conversation.key,'__dm__',1)=nick
          or split_part(conversation.key,'__dm__',2)=nick) and m.value->>'nick'=nick
          and (case when m.value->>'createdAt' ~ '^[0-9]{13}$'
                    then (m.value->>'createdAt')::bigint else 0 end) >= day_start
          and (case when m.value->>'createdAt' ~ '^[0-9]{13}$'
                    then (m.value->>'createdAt')::bigint else 0 end) < day_end;
      proof:=recent_count>=case when p_task_id='prime_dm3' then 3 else 1 end;
    end if;
    if not proof then raise exception 'Task condition not verified'; end if;
    profile:=jsonb_set(profile,array[claimed_key],claimed||to_jsonb(p_task_id),true);
    profile:=jsonb_set(profile,array['__dailyReward_'||day_key||'_'||p_task_id],'true'::jsonb,true);
  elsif p_kind='once' then
    if profile->>p_task_id='true' then return jsonb_build_object('claimed',false,'reason','already claimed'); end if;
    if p_task_id='rewardedAvatar' then
      proof:=coalesce(profile->>'avatar','')<>'';
      reward:=40;
    elsif p_task_id='rewardedWall' then
      select exists(select 1 from public.kp_tree_roots r,
        jsonb_each(coalesce(r.document->nick,'{}'::jsonb)) m where r.branch='walls') into proof;
      reward:=60;
    else
      raise exception 'One-time reward requires a migrated server-side verification';
    end if;
    if not proof then raise exception 'Task condition not verified'; end if;
    profile:=jsonb_set(profile,array[p_task_id],'true'::jsonb,true);
  else
    raise exception 'Invalid task type';
  end if;
  profile:=jsonb_set(profile,'{taskBalance}',to_jsonb(greatest(0,coalesce((profile->>'taskBalance')::bigint,0))+reward),true);
  whole:=jsonb_set(whole,array[nick],profile,true);
  update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('claimed',true,'reward',reward);
end;
$$;
revoke all on function public.kp_claim_task(text,text) from public,anon;
grant execute on function public.kp_claim_task(text,text) to authenticated;

create or replace function public.kp_withdraw_tasks(p_amount bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare nick text; whole jsonb; profile jsonb; rev bigint; available bigint; wallet_balance bigint; event_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_amount is null or p_amount<500 or p_amount>1000000 then raise exception 'Invalid withdrawal amount'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile not found'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots where branch='users' for update;
  profile:=whole->nick;
  available:=greatest(0,coalesce((profile->>'taskBalance')::bigint,0));
  if available<p_amount then return jsonb_build_object('ok',false,'reason','insufficient tasks funds'); end if;
  select balance into wallet_balance from public.kp_wallets where user_id=auth.uid() for update;
  if wallet_balance is null then raise exception 'Wallet unavailable'; end if;
  update public.kp_wallets set balance=balance+p_amount,updated_at=now() where user_id=auth.uid();
  event_id:=gen_random_uuid();
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(event_id,auth.uid(),'wallet',p_amount,'task_withdrawal',jsonb_build_object('source','taskBalance'));
  profile:=jsonb_set(profile,'{taskBalance}',to_jsonb(available-p_amount),true);
  profile:=jsonb_set(profile,'{balance}',to_jsonb(wallet_balance+p_amount),true);
  whole:=jsonb_set(whole,array[nick],profile,true);
  update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'balance',wallet_balance+p_amount,'taskBalance',available-p_amount);
end;
$$;
revoke all on function public.kp_withdraw_tasks(bigint) from public,anon;
grant execute on function public.kp_withdraw_tasks(bigint) to authenticated;

commit;
