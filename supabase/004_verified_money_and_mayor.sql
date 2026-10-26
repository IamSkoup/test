-- Server-authoritative financial operations and mayor administration.
-- Apply only after 001, 002 and 003. Never grant writes to kp_wallets directly.
begin;

create or replace function public.kp_mayor_adjust_balance(
  p_target text, p_delta bigint, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor text; target_uid uuid; root_doc jsonb; rev bigint;
  old_balance bigint; new_balance bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is distinct from 'Кайон' then raise exception 'Mayor access required'; end if;
  if p_request_id is null or p_delta is null or p_delta=0 or abs(p_delta)>1000000 then
    raise exception 'Invalid adjustment amount';
  end if;
  select user_id into target_uid from public.kp_profiles where nickname=p_target;
  if target_uid is null then raise exception 'Recipient not found'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots
    where branch='users' for update;
  if not root_doc ? p_target then raise exception 'Recipient profile missing'; end if;
  select balance into old_balance from public.kp_wallets where user_id=target_uid for update;
  if old_balance is null then raise exception 'Recipient wallet missing'; end if;
  -- The request identifier makes a retry safe after an interrupted response.
  if exists(select 1 from public.kp_ledger where operation_id=p_request_id) then
    return jsonb_build_object('ok',true,'repeated',true,'balance',old_balance);
  end if;
  new_balance:=old_balance+p_delta;
  if new_balance<0 or new_balance>1000000000 then raise exception 'Balance outside permitted range'; end if;
  update public.kp_wallets set balance=new_balance,updated_at=now() where user_id=target_uid;
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(p_request_id,target_uid,'wallet',p_delta,'mayor_adjustment',
      jsonb_build_object('actor',actor,'target',p_target));
  root_doc:=jsonb_set(root_doc,array[p_target,'balance'],to_jsonb(new_balance),true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'balance',new_balance,'adjusted',p_delta);
end;
$$;
revoke all on function public.kp_mayor_adjust_balance(text,bigint,uuid) from public,anon;
grant execute on function public.kp_mayor_adjust_balance(text,bigint,uuid) to authenticated;

create or replace function public.kp_mayor_fine(
  p_target text, p_amount bigint, p_reason text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; treasury jsonb; rev bigint; history_id text;
begin
  if p_amount is null or p_amount<=0 or p_amount>1000000
    or length(trim(coalesce(p_reason,''))) not between 3 and 160 then
    raise exception 'Invalid fine'; end if;
  result:=public.kp_mayor_adjust_balance(p_target,-p_amount,p_request_id);
  if result->>'repeated'='true' then return result; end if;
  insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
  select document,revision into treasury,rev from public.kp_tree_roots
    where branch='municipalTreasury' for update;
  treasury:=jsonb_set(treasury,'{balance}',
    to_jsonb(coalesce((treasury->>'balance')::bigint,0)+p_amount),true);
  history_id:=p_request_id::text;
  treasury:=public.kp_tree_set_deep(treasury,array['history',history_id],
    jsonb_build_object('type','in','amount',p_amount,'reason',trim(p_reason),
      'sourceNick',p_target,'sourceType','fine',
      'ts',(extract(epoch from clock_timestamp())*1000)::bigint));
  update public.kp_tree_roots set document=treasury,revision=rev+1,updated_at=now()
    where branch='municipalTreasury';
  insert into public.kp_tree_revisions(branch,revision) values('municipalTreasury',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return result||jsonb_build_object('fine',true);
end;
$$;
revoke all on function public.kp_mayor_fine(text,bigint,text,uuid) from public,anon;
grant execute on function public.kp_mayor_fine(text,bigint,text,uuid) to authenticated;

create or replace function public.kp_bank_transfer(
  p_recipient text, p_amount bigint, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  sender text; recipient_uid uuid; sender_doc jsonb; recipient_doc jsonb;
  root_doc jsonb; treasury jsonb; rev bigint; treasury_rev bigint;
  sender_balance bigint; recipient_balance bigint; rate numeric; fee bigint; total bigint;
  sender_prime boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into sender from public.kp_profiles where user_id=auth.uid();
  select user_id into recipient_uid from public.kp_profiles where nickname=p_recipient;
  if sender is null or recipient_uid is null or recipient_uid=auth.uid() then
    raise exception 'Invalid recipient';
  end if;
  if p_request_id is null or p_amount is null or p_amount<=0 or p_amount>1000000 then
    raise exception 'Invalid amount';
  end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots where branch='users' for update;
  sender_doc:=root_doc->sender; recipient_doc:=root_doc->p_recipient;
  if sender_doc is null or recipient_doc is null then raise exception 'Account missing'; end if;
  if coalesce(sender_doc->>'accountVerified','false')<>'true'
    or coalesce(recipient_doc->>'accountVerified','false')<>'true' then
    raise exception 'Both accounts must be verified';
  end if;
  if coalesce(sender_doc->'roles'->>'migrant','false')='true'
    or coalesce(recipient_doc->'roles'->>'migrant','false')='true' then
    raise exception 'Transfers disabled for migrant accounts';
  end if;
  if coalesce(sender_doc->>'accountFrozen','false')='true' then
    raise exception 'Account is frozen';
  end if;
  -- Lock both wallets in a deterministic order.
  perform 1 from public.kp_wallets
    where user_id in (auth.uid(),recipient_uid) order by user_id for update;
  select balance into sender_balance from public.kp_wallets where user_id=auth.uid();
  select balance into recipient_balance from public.kp_wallets where user_id=recipient_uid;
  if sender_balance is null or recipient_balance is null then raise exception 'Wallet missing'; end if;
  if exists(select 1 from public.kp_ledger where operation_id=p_request_id) then
    return jsonb_build_object('success',true,'repeated',true,'commissionCharged',true);
  end if;
  sender_prime:=sender_doc->>'subscription'='prime' and
    coalesce((sender_doc->>'subscriptionExpiry')::timestamptz,now()-interval '1 day')>now();
  rate:=case when sender_prime then 0.01 else 0.02 end;
  fee:=greatest(1,round(p_amount*rate)::bigint); total:=p_amount+fee;
  if sender_balance<total then raise exception 'Insufficient funds including fee'; end if;
  if recipient_balance+p_amount>1000000000 then raise exception 'Recipient balance limit'; end if;
  update public.kp_wallets set balance=balance-total,updated_at=now() where user_id=auth.uid();
  update public.kp_wallets set balance=balance+p_amount,updated_at=now() where user_id=recipient_uid;
  -- One ledger row per unique operation_id. The recipient's entry uses a
  -- deterministic second UUID so repeating the request remains idempotent.
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details) values
    (p_request_id,auth.uid(),'wallet',-total,'bank_transfer',jsonb_build_object('to',p_recipient,'fee',fee)),
    ((md5(p_request_id::text||':recipient'))::uuid,recipient_uid,'wallet',p_amount,
      'bank_transfer',jsonb_build_object('from',sender,'transferId',p_request_id));
  root_doc:=jsonb_set(root_doc,array[sender,'balance'],to_jsonb(sender_balance-total),true);
  root_doc:=jsonb_set(root_doc,array[p_recipient,'balance'],to_jsonb(recipient_balance+p_amount),true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  if fee>0 then
    select document,revision into treasury,treasury_rev from public.kp_tree_roots
      where branch='municipalTreasury' for update;
    treasury:=jsonb_set(treasury,'{balance}',
      to_jsonb(coalesce((treasury->>'balance')::bigint,0)+fee),true);
    update public.kp_tree_roots set document=treasury,revision=treasury_rev+1,updated_at=now()
      where branch='municipalTreasury';
    insert into public.kp_tree_revisions(branch,revision)
      values('municipalTreasury',treasury_rev+1)
      on conflict(branch) do update set revision=excluded.revision;
  end if;
  return jsonb_build_object('success',true,'commissionCharged',true,'commission',fee,
    'balance',sender_balance-total,'recipientBalance',recipient_balance+p_amount);
end;
$$;
revoke all on function public.kp_bank_transfer(text,bigint,uuid) from public,anon;
grant execute on function public.kp_bank_transfer(text,bigint,uuid) to authenticated;

create or replace function public.kp_savings_move(
  p_direction text, p_amount bigint, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare nick text; root_doc jsonb; profile jsonb; rev bigint;
  balance_now bigint; savings bigint; movement bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile missing'; end if;
  if p_direction not in ('deposit','withdraw') or p_request_id is null or
    p_amount is null or p_amount<=0 or p_amount>1000000 then
    raise exception 'Invalid savings request';
  end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots
    where branch='users' for update;
  profile:=root_doc->nick;
  if profile is null then raise exception 'Profile missing'; end if;
  select balance into balance_now from public.kp_wallets where user_id=auth.uid() for update;
  if balance_now is null then raise exception 'Wallet missing'; end if;
  if exists(select 1 from public.kp_ledger where operation_id=p_request_id) then
    return jsonb_build_object('ok',true,'repeated',true,'balance',balance_now);
  end if;
  savings:=greatest(0,coalesce((profile->>'savingsBalance')::bigint,0));
  if p_direction='deposit' then
    if coalesce(profile->>'accountFrozen','false')='true' or
      coalesce(profile->'roles'->>'migrant','false')='true' then
      raise exception 'Deposits disabled for this account'; end if;
    if balance_now<p_amount then raise exception 'Insufficient wallet funds'; end if;
    movement:=-p_amount; savings:=savings+p_amount;
  else
    if savings<p_amount then raise exception 'Insufficient savings funds'; end if;
    if balance_now+p_amount>1000000000 then raise exception 'Wallet balance limit'; end if;
    movement:=p_amount; savings:=savings-p_amount;
  end if;
  balance_now:=balance_now+movement;
  update public.kp_wallets set balance=balance_now,updated_at=now() where user_id=auth.uid();
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(p_request_id,auth.uid(),'wallet',movement,'savings_move',
      jsonb_build_object('direction',p_direction,'savings',savings));
  profile:=jsonb_set(profile,'{balance}',to_jsonb(balance_now),true);
  profile:=jsonb_set(profile,'{savingsBalance}',to_jsonb(savings),true);
  if p_direction='deposit' and not profile ? 'savingsLastInterestAt' then
    profile:=jsonb_set(profile,'{savingsLastInterestAt}',
      to_jsonb((extract(epoch from clock_timestamp())*1000)::bigint),true);
  end if;
  root_doc:=jsonb_set(root_doc,array[nick],profile,true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'balance',balance_now,'savingsBalance',savings);
end;
$$;
revoke all on function public.kp_savings_move(text,bigint,uuid) from public,anon;
grant execute on function public.kp_savings_move(text,bigint,uuid) to authenticated;

-- No arbitrary JSON patches. Mayor operations are validated independently.
create or replace function public.kp_mayor_update_resident(
  p_target text, p_action text, p_value jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; root_doc jsonb; profile jsonb; rev bigint;
  target_job text; score integer; license_kind text; emps jsonb; updated jsonb;
  i integer; new_emps jsonb:='[]'::jsonb; item jsonb; present boolean:=false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is distinct from 'Кайон' then raise exception 'Mayor access required'; end if;
  if not exists(select 1 from public.kp_profiles where nickname=p_target) then
    raise exception 'Target account not found';
  end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots where branch='users' for update;
  profile:=root_doc->p_target;
  if profile is null then raise exception 'Target account data missing'; end if;
  if p_action='kve' then
    if jsonb_typeof(p_value)<>'number' or p_value::text !~ '^[0-9]{1,3}$' then
      raise exception 'Invalid exam score'; end if;
    score:=(p_value::text)::integer;
    if score>100 then raise exception 'Exam score outside range'; end if;
    profile:=profile||jsonb_build_object('kveScore',score,
      'kveExamDate',to_char(now() at time zone 'Europe/Moscow','DD.MM.YYYY'),
      'kveScoreSetBy',actor,'kveScoreSetAt',(extract(epoch from clock_timestamp())*1000)::bigint);
  elsif p_action='migrant' then
    if jsonb_typeof(p_value)<>'boolean' or p_target=actor then
      raise exception 'Invalid role change'; end if;
    profile:=jsonb_set(profile,'{roles}',
      coalesce(profile->'roles','{}'::jsonb)||jsonb_build_object('migrant',p_value),true);
  elsif p_action='job' then
    if jsonb_typeof(p_value)<>'string' then raise exception 'Invalid job'; end if;
    target_job:=p_value #>> '{}';
    if target_job not in ('Водитель','Доставщик','Уборщик','Журналист','КСБ',
      'Депутат','Полицейский','Рекламщик','Врач') then raise exception 'Unknown job'; end if;
    emps:=coalesce(profile->'employments','[]'::jsonb);
    if jsonb_typeof(emps)<>'array' then emps:='[]'::jsonb; end if;
    for item in select value from jsonb_array_elements(emps) loop
      if item->>'id'='muni_'||target_job then present:=true; end if;
      if item->>'id'<>'muni_'||target_job then new_emps:=new_emps||jsonb_build_array(item); end if;
    end loop;
    if not present and jsonb_array_length(new_emps)>=5 then
      raise exception 'Employment limit reached'; end if;
    new_emps:=new_emps||jsonb_build_array(jsonb_build_object(
      'id','muni_'||target_job,'type','municipal','role',target_job));
    profile:=profile||jsonb_build_object('job',target_job,'vehicle','',
      'employments',new_emps,'displayJob',coalesce(nullif(profile->>'displayJob',''),target_job));
    if target_job='Уборщик' then
      profile:=profile||jsonb_build_object('janitorSubmissionStatus','ready',
        'janitorSubmissionId','','janitorProof','','janitorComment','');
    end if;
  elsif p_action='license' then
    if jsonb_typeof(p_value)<>'object' or not (p_value ? 'kind')
      or not (p_value ? 'enabled') or jsonb_typeof(p_value->'enabled')<>'boolean' then
      raise exception 'Invalid license change'; end if;
    license_kind:=p_value->>'kind';
    if license_kind not in ('bike','scooter') then raise exception 'Unknown license'; end if;
    updated:=coalesce(profile->'licenses','{}'::jsonb)||
      jsonb_build_object(license_kind,p_value->'enabled');
    if p_value->>'enabled'='true' then
      updated:=updated||jsonb_build_object(license_kind||'IssuedAt',
        (extract(epoch from clock_timestamp())*1000)::bigint);
    end if;
    profile:=jsonb_set(profile,'{licenses}',updated,true);
  elsif p_action='fire' then
    if p_target=actor then raise exception 'Mayor cannot fire own account'; end if;
    -- The role used for an employment removal is rechecked on the server.
    target_job:=p_value #>> '{}';
    if target_job is null or length(target_job)>80 then raise exception 'Invalid job to remove'; end if;
    emps:=coalesce(profile->'employments','[]'::jsonb);
    if jsonb_typeof(emps)<>'array' then emps:='[]'::jsonb; end if;
    for item in select value from jsonb_array_elements(emps) loop
      if not (item->>'type'='municipal' and item->>'role'=target_job) then
        new_emps:=new_emps||jsonb_build_array(item);
      else present:=true; end if;
    end loop;
    if not present and profile->>'job'<>target_job then
      raise exception 'Target has no such municipal job'; end if;
    profile:=profile||jsonb_build_object('employments',new_emps,
      'job',coalesce((select x->>'role' from jsonb_array_elements(new_emps) x
        where x->>'type'='municipal' limit 1),'Житель'),
      'displayJob',coalesce((select x->>'role' from jsonb_array_elements(new_emps) x limit 1),'Житель'));
    if target_job in ('Водитель','Доставщик') then profile:=jsonb_set(profile,'{vehicle}','""'::jsonb,true); end if;
  else
    raise exception 'Unsupported mayor operation';
  end if;
  root_doc:=jsonb_set(root_doc,array[p_target],profile,true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'target',p_target,'action',p_action);
end;
$$;
revoke all on function public.kp_mayor_update_resident(text,text,jsonb) from public,anon;
grant execute on function public.kp_mayor_update_resident(text,text,jsonb) to authenticated;

-- One protected read for both mayor and account owner, instead of exposing
-- the entire private licenses branch to all clients.
create or replace function public.kp_license_status(p_target text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor text; source jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is distinct from 'Кайон' and actor is distinct from p_target then
    raise exception 'Private profile data'; end if;
  select document->p_target->'licenses' into source
    from public.kp_tree_roots where branch='users';
  return coalesce(source,'{}'::jsonb);
end;
$$;
revoke all on function public.kp_license_status(text) from public,anon;
grant execute on function public.kp_license_status(text) to authenticated;

create or replace function public.kp_referral_summary(p_target text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor text; users jsonb; stats jsonb; target text; count_for_target bigint;
  output jsonb:='[]'::jsonb; entry record; reset_time bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  target:=coalesce(p_target,actor);
  if target<>actor and actor<>'Кайон' then raise exception 'Private referral stats'; end if;
  select document into users from public.kp_tree_roots where branch='users';
  select document into stats from public.kp_tree_roots where branch='advertiserStats';
  if p_target is not null then
    reset_time:=coalesce((stats->target->>'resetAt')::bigint,0);
    select count(*) into count_for_target from jsonb_each(coalesce(users,'{}'::jsonb)) u
      where u.value->>'invitedBy'=target and
        coalesce((u.value->>'referralCreatedAt')::bigint,(u.value->>'createdAt')::bigint,0)>reset_time;
    return jsonb_build_object('count',count_for_target);
  end if;
  if actor<>'Кайон' then raise exception 'Mayor access required'; end if;
  for entry in select key,value from jsonb_each(coalesce(users,'{}'::jsonb)) loop
    if entry.value->>'job'='Рекламщик' then
      reset_time:=coalesce((stats->(entry.key)->>'resetAt')::bigint,0);
      select count(*) into count_for_target from jsonb_each(coalesce(users,'{}'::jsonb)) u
        where u.value->>'invitedBy'=entry.key and
          coalesce((u.value->>'referralCreatedAt')::bigint,(u.value->>'createdAt')::bigint,0)>reset_time;
      output:=output||jsonb_build_array(jsonb_build_object('nick',
        coalesce(nullif(entry.value->>'displayName',''),entry.key),'count',count_for_target));
    end if;
  end loop;
  return output;
end;
$$;
revoke all on function public.kp_referral_summary(text) from public,anon;
grant execute on function public.kp_referral_summary(text) to authenticated;

create or replace function public.kp_mayor_clear_referrals()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; users jsonb; stats jsonb; rev bigint; entry record;
  reset_time bigint; num integer:=0;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is distinct from 'Кайон' then raise exception 'Mayor access required'; end if;
  select document into users from public.kp_tree_roots where branch='users';
  insert into public.kp_tree_roots(branch) values('advertiserStats') on conflict do nothing;
  select document,revision into stats,rev from public.kp_tree_roots
    where branch='advertiserStats' for update;
  reset_time:=(extract(epoch from clock_timestamp())*1000)::bigint;
  for entry in select key,value from jsonb_each(coalesce(users,'{}'::jsonb)) loop
    if entry.value->>'job'='Рекламщик' then
      stats:=jsonb_set(stats,array[entry.key],jsonb_build_object(
        'total',0,'resetAt',reset_time,'updatedAt',reset_time),true);
      num:=num+1;
    end if;
  end loop;
  update public.kp_tree_roots set document=stats,revision=rev+1,updated_at=now()
    where branch='advertiserStats';
  insert into public.kp_tree_revisions(branch,revision) values('advertiserStats',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'cleared',num);
end;
$$;
revoke all on function public.kp_mayor_clear_referrals() from public,anon;
grant execute on function public.kp_mayor_clear_referrals() to authenticated;

create or replace function public.kp_mayor_queue(p_branch text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor text; queue_doc jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is distinct from 'Кайон' then raise exception 'Mayor access required'; end if;
  if p_branch not in ('atmRequests','deputyProposals') then
    raise exception 'Invalid queue'; end if;
  select document into queue_doc from public.kp_tree_roots where branch=p_branch;
  return coalesce(queue_doc,'{}'::jsonb);
end;
$$;
revoke all on function public.kp_mayor_queue(text) from public,anon;
grant execute on function public.kp_mayor_queue(text) to authenticated;

create or replace function public.kp_mayor_review_queue(
  p_branch text,p_id text,p_status text,p_comment text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; root_doc jsonb; rev bigint; item jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is distinct from 'Кайон' then raise exception 'Mayor access required'; end if;
  if p_branch not in ('atmRequests','deputyProposals') or
    p_status not in ('approved','rejected') or
    length(coalesce(p_id,'')) not between 1 and 120 or
    length(coalesce(p_comment,''))>500 then
    raise exception 'Invalid review'; end if;
  select document,revision into root_doc,rev from public.kp_tree_roots
    where branch=p_branch for update;
  item:=root_doc->p_id;
  if item is null then raise exception 'Request not found'; end if;
  if item->>'status'<>'pending' then raise exception 'Request already reviewed'; end if;
  item:=item||jsonb_build_object('status',p_status,
    'reviewedAt',(extract(epoch from clock_timestamp())*1000)::bigint);
  if p_branch='deputyProposals' then
    item:=item||jsonb_build_object('adminComment',nullif(trim(p_comment),''));
  end if;
  root_doc:=jsonb_set(root_doc,array[p_id],item,true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now()
    where branch=p_branch;
  insert into public.kp_tree_revisions(branch,revision) values(p_branch,rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'request',item);
end;
$$;
revoke all on function public.kp_mayor_review_queue(text,text,text,text) from public,anon;
grant execute on function public.kp_mayor_review_queue(text,text,text,text) to authenticated;

-- Legacy one-time achievements must be proven by server-owned records before
-- granting any task currency. Deliberately no caller-specified reward amount.
create or replace function public.kp_claim_migrated_once(p_task_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare nick text; users jsonb; user_doc jsonb; rev bigint; reward integer;
  allowed boolean:=false; evidence jsonb; first_seen boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile missing'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into users,rev from public.kp_tree_roots where branch='users' for update;
  user_doc:=users->nick;
  if user_doc is null then raise exception 'Account missing'; end if;
  if user_doc->>p_task_id='true' then return jsonb_build_object('claimed',false,'reason','already claimed'); end if;
  if coalesce(user_doc->'roles'->>'migrant','false')='true' then raise exception 'Tasks not permitted'; end if;
  if p_task_id='rewardedPassport' then
    reward:=80;
    select document->nick into evidence from public.kp_tree_roots where branch='passports';
    allowed:=nullif(evidence->>'firstName','') is not null and nullif(evidence->>'lastName','') is not null;
  elsif p_task_id='rewardedAllLicenses' then
    reward:=90;
    allowed:=coalesce(user_doc->'licenses'->>'bike','false')='true'
      and coalesce(user_doc->'licenses'->>'scooter','false')='true';
  elsif p_task_id='rewardedJob' then
    reward:=100;allowed:=coalesce(user_doc->>'job','Житель')<>'Житель';
  elsif p_task_id='rewardedListing' then
    reward:=60;
    select exists(select 1 from public.kp_tree_roots r,
      jsonb_each(coalesce(r.document,'{}'::jsonb)) m
      where r.branch='marketplace' and m.value->>'seller'=nick) into allowed;
  elsif p_task_id='rewardedTaxi' then
    reward:=80;
    select exists(select 1 from public.kp_tree_roots r,
      jsonb_each(coalesce(r.document,'{}'::jsonb)) o
      where r.branch='orders' and o.value->>'client'=nick and o.value->>'type'='taxi') into allowed;
  elsif p_task_id='rewardedMarket' then
    reward:=90;
    select exists(select 1 from public.kp_tree_roots r,
      jsonb_each(coalesce(r.document,'{}'::jsonb)) o
      where r.branch='orders' and o.value->>'client'=nick and o.value->>'type'='market') into allowed;
  else
    raise exception 'Unknown achievement';
  end if;
  if not allowed then raise exception 'Achievement not verified on server'; end if;
  user_doc:=jsonb_set(user_doc,array[p_task_id],'true'::jsonb,true);
  user_doc:=jsonb_set(user_doc,'{taskBalance}',
    to_jsonb(greatest(0,coalesce((user_doc->>'taskBalance')::bigint,0))+reward),true);
  users:=jsonb_set(users,array[nick],user_doc,true);
  update public.kp_tree_roots set document=users,revision=rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('claimed',true,'reward',reward);
end;
$$;
revoke all on function public.kp_claim_migrated_once(text) from public,anon;
grant execute on function public.kp_claim_migrated_once(text) to authenticated;

commit;
