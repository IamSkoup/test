-- Owner-only passport and verified mayor operations.
-- Run after 001_tree_bridge.sql and 002_account_and_tasks.sql.
-- Neither the nickname supplied by the browser nor a client-admin flag grants rights.
begin;

create or replace function public.kp_save_passport(
  p_first_name text, p_last_name text, p_dob text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  nick text; root_doc jsonb; rev bigint; date_of_birth date;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile registration required'; end if;
  if length(trim(coalesce(p_first_name,''))) not between 1 and 40
     or length(trim(coalesce(p_last_name,''))) not between 1 and 40
     or p_dob is null or p_dob !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Invalid passport details';
  end if;
  date_of_birth:=p_dob::date;
  if date_of_birth>current_date or date_of_birth<date '1900-01-01'
    or to_char(date_of_birth,'YYYY-MM-DD')<>p_dob then
    raise exception 'Invalid birth date';
  end if;
  insert into public.kp_tree_roots(branch) values('passports') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots
    where branch='passports' for update;
  root_doc:=jsonb_set(root_doc,array[nick],jsonb_build_object(
    'firstName',trim(p_first_name),'lastName',trim(p_last_name),
    'dob',p_dob,'issuedAt',(extract(epoch from clock_timestamp())*1000)::bigint
  ),true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now()
    where branch='passports';
  insert into public.kp_tree_revisions(branch,revision) values('passports',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.kp_save_passport(text,text,text) from public,anon;
grant execute on function public.kp_save_passport(text,text,text) to authenticated;

create or replace function public.kp_verify_account(p_target_nick text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_nick text; root_doc jsonb; rev bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor_nick from public.kp_profiles where user_id=auth.uid();
  if actor_nick <> 'Кайон' or actor_nick is null then raise exception 'Mayor access required'; end if;
  if length(coalesce(p_target_nick,'')) not between 2 and 120 then
    raise exception 'Invalid account';
  end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots
    where branch='users' for update;
  if not root_doc ? p_target_nick then raise exception 'Account not found'; end if;
  root_doc:=jsonb_set(root_doc,array[p_target_nick,'accountVerified'],'true'::jsonb,true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'nick',p_target_nick);
end;
$$;
revoke all on function public.kp_verify_account(text) from public,anon;
grant execute on function public.kp_verify_account(text) to authenticated;

create or replace function public.kp_municipal_treasury_snapshot()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor_nick text; treasury jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor_nick from public.kp_profiles where user_id=auth.uid();
  if actor_nick <> 'Кайон' or actor_nick is null then raise exception 'Mayor access required'; end if;
  select document into treasury from public.kp_tree_roots where branch='municipalTreasury';
  return jsonb_build_object('balance',coalesce((treasury->>'balance')::numeric,0),
    'history',coalesce(treasury->'history','{}'::jsonb));
end;
$$;
revoke all on function public.kp_municipal_treasury_snapshot() from public,anon;
grant execute on function public.kp_municipal_treasury_snapshot() to authenticated;

create or replace function public.kp_municipal_treasury_clear_history()
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor_nick text; root_doc jsonb; rev bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor_nick from public.kp_profiles where user_id=auth.uid();
  if actor_nick <> 'Кайон' or actor_nick is null then raise exception 'Mayor access required'; end if;
  insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
  select document,revision into root_doc,rev from public.kp_tree_roots
    where branch='municipalTreasury' for update;
  root_doc:=jsonb_set(root_doc,'{history}','{}'::jsonb,true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now()
    where branch='municipalTreasury';
  insert into public.kp_tree_revisions(branch,revision) values('municipalTreasury',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.kp_municipal_treasury_clear_history() from public,anon;
grant execute on function public.kp_municipal_treasury_clear_history() to authenticated;

-- Transfers the mayor's own treasury funds and updates the protected wallet
-- atomically. The browser may request an amount but cannot manufacture one.
create or replace function public.kp_municipal_treasury_withdraw(p_amount bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor_nick text; treasury jsonb; users_root jsonb; t_rev bigint; u_rev bigint;
  available bigint; wallet_balance bigint; movement uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor_nick from public.kp_profiles where user_id=auth.uid();
  if actor_nick <> 'Кайон' or actor_nick is null then raise exception 'Mayor access required'; end if;
  if p_amount is null or p_amount<=0 or p_amount>1000000 then raise exception 'Invalid withdrawal amount'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
  select document,revision into users_root,u_rev from public.kp_tree_roots where branch='users' for update;
  select document,revision into treasury,t_rev from public.kp_tree_roots where branch='municipalTreasury' for update;
  if not users_root ? actor_nick then raise exception 'Mayor account data missing'; end if;
  available:=coalesce((treasury->>'balance')::bigint,0);
  if available<p_amount then return jsonb_build_object('ok',false,'reason','insufficient treasury funds','balance',available); end if;
  select balance into wallet_balance from public.kp_wallets where user_id=auth.uid() for update;
  if wallet_balance is null then raise exception 'Protected wallet missing'; end if;

  update public.kp_wallets set balance=balance+p_amount,updated_at=now() where user_id=auth.uid();
  movement:=gen_random_uuid();
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(movement,auth.uid(),'wallet',p_amount,'treasury_withdrawal',jsonb_build_object('origin','municipalTreasury'));

  users_root:=jsonb_set(users_root,array[actor_nick,'balance'],to_jsonb(wallet_balance+p_amount),true);
  update public.kp_tree_roots set document=users_root,revision=u_rev+1,updated_at=now() where branch='users';
  treasury:=jsonb_set(treasury,'{balance}',to_jsonb(available-p_amount),true);
  treasury:=jsonb_set(treasury,array['history',movement::text],jsonb_build_object(
    'type','out','amount',p_amount,'reason','Вывод средств мэром',
    'sourceNick',actor_nick,'sourceType','mayor_withdrawal',
    'date',to_char(now(),'DD.MM.YYYY'),'time',to_char(now(),'HH24:MI'),
    'ts',(extract(epoch from clock_timestamp())*1000)::bigint
  ),true);
  update public.kp_tree_roots set document=treasury,revision=t_rev+1,updated_at=now()
    where branch='municipalTreasury';
  insert into public.kp_tree_revisions(branch,revision)
    values('users',u_rev+1),('municipalTreasury',t_rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'balance',available-p_amount,'walletBalance',wallet_balance+p_amount);
end;
$$;
revoke all on function public.kp_municipal_treasury_withdraw(bigint) from public,anon;
grant execute on function public.kp_municipal_treasury_withdraw(bigint) to authenticated;

-- The weekly maintenance request may only charge the logged-in user's own
-- wallet, only once per elapsed week, with all amounts computed on the server.
-- Actual charges are capped by the available wallet balance; no debt can be
-- created through an unchecked client patch. Savings are part of the tax base.
create or replace function public.kp_process_economy_charges()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  nick text; users_root jsonb; treasury jsonb; user_doc jsonb;
  u_rev bigint; t_rev bigint; wallet_balance bigint; savings bigint;
  current_ms bigint; marker bigint; completed bigint; weeks integer;
  i integer; tax_base bigint; tax_rate numeric; assessment bigint; debit bigint;
  total_debit bigint:=0; movement uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into nick from public.kp_profiles where user_id=auth.uid();
  if nick is null then raise exception 'Profile registration required'; end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
  select document,revision into users_root,u_rev from public.kp_tree_roots where branch='users' for update;
  user_doc:=users_root->nick;
  if user_doc is null then raise exception 'Profile document missing'; end if;
  select balance into wallet_balance from public.kp_wallets where user_id=auth.uid() for update;
  if wallet_balance is null then raise exception 'Protected wallet missing'; end if;
  current_ms:=(extract(epoch from clock_timestamp())*1000)::bigint;
  marker:=nullif(user_doc->>'economyLastProcessedAt','')::bigint;
  if marker is null or marker>current_ms then marker:=current_ms; end if;
  weeks:=least(52,greatest(0,((current_ms-marker)/604800000)::integer));
  if weeks=0 then
    if not (user_doc ? 'economyLastProcessedAt') then
      users_root:=jsonb_set(users_root,array[nick,'economyLastProcessedAt'],to_jsonb(marker),true);
      update public.kp_tree_roots set document=users_root,revision=u_rev+1,updated_at=now() where branch='users';
      insert into public.kp_tree_revisions(branch,revision) values('users',u_rev+1)
        on conflict(branch) do update set revision=excluded.revision;
    end if;
    return jsonb_build_object('ok',true,'weeks',0,'charged',0,'balance',wallet_balance);
  end if;
  savings:=greatest(0,coalesce((user_doc->>'savingsBalance')::bigint,0));
  for i in 1..weeks loop
    tax_base:=greatest(0,wallet_balance)+savings;
    tax_rate:=case when tax_base<1000 then 0.07 when tax_base<=10000 then 0.10
      when tax_base<=100000 then 0.17 else 0.25 end;
    assessment:=15+round(tax_base*tax_rate)::bigint;
    debit:=least(greatest(0,wallet_balance),assessment);
    wallet_balance:=wallet_balance-debit;
    total_debit:=total_debit+debit;
  end loop;
  completed:=marker+(weeks::bigint*604800000);
  update public.kp_wallets set balance=wallet_balance,updated_at=now() where user_id=auth.uid();
  users_root:=jsonb_set(users_root,array[nick,'balance'],to_jsonb(wallet_balance),true);
  users_root:=jsonb_set(users_root,array[nick,'economyLastProcessedAt'],to_jsonb(completed),true);
  update public.kp_tree_roots set document=users_root,revision=u_rev+1,updated_at=now() where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',u_rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  if total_debit>0 then
    movement:=gen_random_uuid();
    insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
      values(movement,auth.uid(),'wallet',-total_debit,'weekly_economy_charges',
        jsonb_build_object('weeks',weeks,'fees_and_taxes',total_debit));
    select document,revision into treasury,t_rev from public.kp_tree_roots
      where branch='municipalTreasury' for update;
    treasury:=jsonb_set(treasury,'{balance}',to_jsonb(coalesce((treasury->>'balance')::bigint,0)+total_debit),true);
    update public.kp_tree_roots set document=treasury,revision=t_rev+1,updated_at=now()
      where branch='municipalTreasury';
    insert into public.kp_tree_revisions(branch,revision) values('municipalTreasury',t_rev+1)
      on conflict(branch) do update set revision=excluded.revision;
  end if;
  return jsonb_build_object('ok',true,'weeks',weeks,'charged',total_debit,'balance',wallet_balance);
end;
$$;
revoke all on function public.kp_process_economy_charges() from public,anon;
grant execute on function public.kp_process_economy_charges() to authenticated;

commit;
