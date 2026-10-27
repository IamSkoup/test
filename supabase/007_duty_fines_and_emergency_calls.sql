-- Kapani security/medical dispatch and KSB fines.
-- Run AFTER 001..006 in Supabase SQL Editor. No direct writes to other users are granted.
begin;

create or replace function public.kp_dispatch_role_allowed(p_kind text, p_profile jsonb)
returns boolean language sql immutable set search_path='' as $$
  select coalesce(
    (p_kind='security' and (
      p_profile->>'job' in ('КСБ','Полицейский') or
      exists (select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_profile->'employments')='array'
          then p_profile->'employments' else '[]'::jsonb end
      ) as e where e->>'type'='municipal' and e->>'role' in ('КСБ','Полицейский'))
    )) or
    (p_kind='medical' and (
      p_profile->>'job' in ('Врач','Помощник врача') or
      exists (select 1 from jsonb_array_elements(
        case when jsonb_typeof(p_profile->'employments')='array'
          then p_profile->'employments' else '[]'::jsonb end
      ) as e where e->>'type'='municipal' and e->>'role' in ('Врач','Помощник врача'))
    )),false);
$$;
revoke all on function public.kp_dispatch_role_allowed(text,jsonb) from public,anon,authenticated;

create or replace function public.kp_duty_fine(
  p_target text, p_amount bigint, p_reason text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor text; actor_profile jsonb; target_uid uuid; target_profile jsonb;
  root_doc jsonb; treasury jsonb; users_rev bigint; treasury_rev bigint;
  old_balance bigint; new_balance bigint; actor_role text; exists_op boolean;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile required'; end if;
  if p_request_id is null or p_amount is null or p_amount<=0 or p_amount>1000000
    or length(trim(coalesce(p_reason,''))) not between 3 and 200 then
    raise exception 'Invalid fine';
  end if;
  if p_target is null or p_target=actor then raise exception 'Invalid target'; end if;
  select user_id into target_uid from public.kp_profiles where nickname=p_target;
  if target_uid is null then raise exception 'Recipient not found'; end if;

  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into root_doc,users_rev from public.kp_tree_roots
    where branch='users' for update;
  actor_profile:=root_doc->actor;
  target_profile:=root_doc->p_target;
  if target_profile is null or actor_profile is null then raise exception 'Account missing'; end if;
  if actor <> 'Кайон' and not public.kp_dispatch_role_allowed('security',actor_profile) then
    raise exception 'KSB/police access required';
  end if;
  actor_role:=case when actor='Кайон' then 'Мэрия'
    when actor_profile->>'job'='КСБ' or exists(
      select 1 from jsonb_array_elements(case when jsonb_typeof(actor_profile->'employments')='array'
        then actor_profile->'employments' else '[]'::jsonb end) e
      where e->>'type'='municipal' and e->>'role'='КСБ') then 'КСБ'
    else 'Полиция' end;
  select balance into old_balance from public.kp_wallets where user_id=target_uid for update;
  if old_balance is null then raise exception 'Recipient wallet missing'; end if;
  select exists(select 1 from public.kp_ledger where operation_id=p_request_id)
    into exists_op;
  if exists_op then
    if not exists(select 1 from public.kp_ledger where operation_id=p_request_id
      and user_id=target_uid and kind='duty_fine') then
      raise exception 'Request identifier already used';
    end if;
    return jsonb_build_object('ok',true,'repeated',true,'balance',old_balance);
  end if;
  new_balance:=old_balance-p_amount;
  -- The site's configured debt floor is -2500 ₽. Never exceed it.
  if new_balance < -2500 then raise exception 'Штраф превысит допустимый долг -2500 ₽'; end if;
  update public.kp_wallets set balance=new_balance,updated_at=now() where user_id=target_uid;
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(p_request_id,target_uid,'wallet',-p_amount,'duty_fine',
      jsonb_build_object('actor',actor,'role',actor_role,'reason',trim(p_reason),'target',p_target));
  root_doc:=jsonb_set(root_doc,array[p_target,'balance'],to_jsonb(new_balance),true);
  update public.kp_tree_roots set document=root_doc,revision=users_rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',users_rev+1)
    on conflict(branch) do update set revision=excluded.revision;

  insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
  select document,revision into treasury,treasury_rev from public.kp_tree_roots
    where branch='municipalTreasury' for update;
  treasury:=jsonb_set(coalesce(treasury,'{}'::jsonb),'{balance}',
    to_jsonb(coalesce((treasury->>'balance')::bigint,0)+p_amount),true);
  treasury:=public.kp_tree_set_deep(treasury,array['history',p_request_id::text],
    jsonb_build_object('type','in','amount',p_amount,'reason','Штраф: '||trim(p_reason),
      'sourceNick',p_target,'sourceType','fine','issuedBy',actor,
      'ts',(extract(epoch from clock_timestamp())*1000)::bigint));
  update public.kp_tree_roots set document=treasury,revision=treasury_rev+1,updated_at=now()
    where branch='municipalTreasury';
  insert into public.kp_tree_revisions(branch,revision) values('municipalTreasury',treasury_rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'balance',new_balance,'target',p_target,'role',actor_role);
end;
$$;
revoke all on function public.kp_duty_fine(text,bigint,text,uuid) from public,anon;
grant execute on function public.kp_duty_fine(text,bigint,text,uuid) to authenticated;

create or replace function public.kp_dispatch_create(
  p_kind text, p_name text, p_address text, p_description text,
  p_photo text, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; doc jsonb; rev bigint; call_record jsonb; call_id text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile required'; end if;
  if p_kind not in ('security','medical') or p_request_id is null
    or length(trim(coalesce(p_name,''))) not between 1 and 60
    or length(trim(coalesce(p_address,''))) not between 3 and 120
    or length(trim(coalesce(p_description,''))) not between 5 and 500
    or length(coalesce(p_photo,''))>2000000
    or (p_photo is not null and p_photo !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')
    then raise exception 'Invalid call details'; end if;
  call_id:=p_request_id::text;
  insert into public.kp_tree_roots(branch) values('calls') on conflict do nothing;
  select document,revision into doc,rev from public.kp_tree_roots
    where branch='calls' for update;
  if doc ? call_id then return jsonb_build_object('ok',true,'id',call_id,'repeated',true); end if;
  if (select count(*) from jsonb_each(coalesce(doc,'{}'::jsonb)) as existing
      where existing.value->>'from'=actor
        and coalesce((existing.value->>'createdAt')::bigint,0)>
          (extract(epoch from clock_timestamp())*1000)::bigint-60000) >= 3 then
    raise exception 'Слишком много вызовов за минуту';
  end if;
  call_record:=jsonb_build_object('id',call_id,'kind',p_kind,'name',trim(p_name),
    'address',trim(p_address),'desc',trim(p_description),'from',actor,
    'status','new','createdAt',(extract(epoch from clock_timestamp())*1000)::bigint,
    'time',to_char(clock_timestamp() at time zone 'Europe/Moscow','DD.MM.YYYY HH24:MI'));
  if length(coalesce(p_photo,''))>0 then
    call_record:=call_record||jsonb_build_object('photo',p_photo);
  end if;
  doc:=jsonb_set(coalesce(doc,'{}'::jsonb),array[call_id],call_record,true);
  update public.kp_tree_roots set document=doc,revision=rev+1,updated_at=now()
    where branch='calls';
  insert into public.kp_tree_revisions(branch,revision) values('calls',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'id',call_id);
end;
$$;
revoke all on function public.kp_dispatch_create(text,text,text,text,text,uuid) from public,anon;
grant execute on function public.kp_dispatch_create(text,text,text,text,text,uuid) to authenticated;

create or replace function public.kp_dispatch_list(p_kind text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor text; user_doc jsonb; calls_doc jsonb; results jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_kind not in ('security','medical') then raise exception 'Invalid call kind'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  select document->actor into user_doc from public.kp_tree_roots where branch='users';
  if actor is null or (actor<>'Кайон'
    and not public.kp_dispatch_role_allowed(p_kind,user_doc)) then
    raise exception 'Dispatch access required';
  end if;
  select document into calls_doc from public.kp_tree_roots where branch='calls';
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into results
    from jsonb_each(coalesce(calls_doc,'{}'::jsonb))
    where coalesce(value->>'kind','security')=p_kind
      and coalesce(value->>'status','new')<>'closed';
  return results;
end;
$$;
revoke all on function public.kp_dispatch_list(text) from public,anon;
grant execute on function public.kp_dispatch_list(text) to authenticated;

create or replace function public.kp_dispatch_close(p_kind text, p_call_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; user_doc jsonb; doc jsonb; rev bigint; c jsonb; call_id text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_kind not in ('security','medical') or p_call_id is null then
    raise exception 'Invalid dispatch request'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  select document->actor into user_doc from public.kp_tree_roots where branch='users';
  if actor is null or (actor<>'Кайон'
    and not public.kp_dispatch_role_allowed(p_kind,user_doc)) then
    raise exception 'Dispatch access required'; end if;
  call_id:=p_call_id::text;
  select document,revision into doc,rev from public.kp_tree_roots
    where branch='calls' for update;
  c:=doc->call_id;
  if c is null or coalesce(c->>'kind','security')<>p_kind then
    raise exception 'Call not found'; end if;
  if c->>'status'='closed' then return jsonb_build_object('ok',true,'repeated',true); end if;
  c:=c||jsonb_build_object('status','closed','closedBy',actor,
    'closedAt',(extract(epoch from clock_timestamp())*1000)::bigint);
  doc:=jsonb_set(doc,array[call_id],c,true);
  update public.kp_tree_roots set document=doc,revision=rev+1,updated_at=now()
    where branch='calls';
  insert into public.kp_tree_revisions(branch,revision) values('calls',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.kp_dispatch_close(text,uuid) from public,anon;
grant execute on function public.kp_dispatch_close(text,uuid) to authenticated;

create or replace function public.kp_dispatch_recipients(p_kind text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare doc jsonb; result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_kind not in ('security','medical') then raise exception 'Invalid call kind'; end if;
  select document into doc from public.kp_tree_roots where branch='users';
  select coalesce(jsonb_agg(key),'[]'::jsonb) into result
    from jsonb_each(coalesce(doc,'{}'::jsonb))
    where public.kp_dispatch_role_allowed(p_kind,value);
  return result;
end;
$$;
revoke all on function public.kp_dispatch_recipients(text) from public,anon;
grant execute on function public.kp_dispatch_recipients(text) to authenticated;

-- Show KSB fines with the issuer and the reason in the existing bank history.
create or replace function public.kp_my_transactions()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor text; legacy jsonb; result jsonb:='[]'::jsonb;
  entry record; meta jsonb; details jsonb; row_time timestamptz;
  raw_time text; kind_name text; who_name text; description text;
  amount_value bigint; action_type text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  for entry in
    select * from public.kp_ledger l where l.user_id=auth.uid()
    order by coalesce(to_jsonb(l)->>'created_at',to_jsonb(l)->>'createdAt','') desc
    limit 500
  loop
    meta:=to_jsonb(entry); details:=coalesce(meta->'details','{}'::jsonb);
    amount_value:=coalesce((meta->>'amount')::bigint,0);
    kind_name:=coalesce(meta->>'kind','operation');
    action_type:=case when amount_value<0 then 'out' else 'in' end;
    raw_time:=coalesce(meta->>'created_at',meta->>'createdAt','');
    row_time:=null;
    if raw_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then row_time:=raw_time::timestamptz;
    elsif raw_time ~ '^[0-9]{12,13}$' then row_time:=to_timestamp(raw_time::numeric/1000); end if;
    who_name:=case kind_name
      when 'bank_transfer' then coalesce(details->>'to',details->>'from','Житель')
      when 'mayor_adjustment' then 'Мэрия'
      when 'duty_fine' then coalesce(details->>'role','КСБ')||' ('||coalesce(details->>'actor','сотрудник')||')'
      when 'market_purchase' then coalesce(details->>'seller','Маркетплейс')
      when 'market_sale' then coalesce(details->>'buyer','Маркетплейс')
      when 'savings_move' then 'Накопительный счёт'
      when 'treasury_withdrawal' then 'Казна мэрии'
      when 'business_promotion' then 'Бизнес'
      when 'market_pin' then 'Маркетплейс'
      else 'Капани' end;
    description:=case kind_name
      when 'bank_transfer' then 'Банковский перевод'||
        case when details ? 'fee' then ' · комиссия '||(details->>'fee')||' ₽' else '' end
      when 'mayor_adjustment' then 'Корректировка баланса мэрией'
      when 'duty_fine' then 'Штраф: '||coalesce(details->>'reason','без причины')
      when 'market_purchase' then 'Покупка через маркет'
      when 'market_sale' then 'Продажа через маркет'
      when 'savings_move' then case when details->>'direction'='deposit'
        then 'Пополнение накопительного счёта' else 'Снятие с накопительного счёта' end
      when 'treasury_withdrawal' then 'Вывод из казны'
      when 'business_promotion' then 'Продвижение бизнеса'
      when 'market_pin' then 'Закрепление объявления'
      when 'task_withdrawal' then 'Вывод средств заданий'
      else kind_name end;
    result:=result||jsonb_build_array(jsonb_build_object(
      'id',coalesce(meta->>'operation_id',''),'type',action_type,'amt',abs(amount_value),
      'who',who_name,'desc',description,
      'ts',case when row_time is not null then to_char(row_time at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') else '' end,
      'date',case when row_time is not null then to_char(row_time at time zone 'Europe/Moscow','DD.MM.YYYY') else '' end,
      'time',case when row_time is not null then to_char(row_time at time zone 'Europe/Moscow','HH24:MI') else '' end
    ));
  end loop;
  select document->actor->'txlog' into legacy from public.kp_tree_roots where branch='users';
  if jsonb_typeof(legacy)='object' then
    result:=result||coalesce((select jsonb_agg(value) from jsonb_each(legacy)),'[]'::jsonb);
  end if;
  return result;
end;
$$;
revoke all on function public.kp_my_transactions() from public,anon;
grant execute on function public.kp_my_transactions() to authenticated;

commit;
