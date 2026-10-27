-- Kapani 14. Apply manually, after 017. No old savings interest is backpaid.
-- This file does not access the database until the owner explicitly runs it.
begin;

-- The legacy user-tree bridge denies direct writes to paid cosmetics. Keep that
-- protection and offer a narrowly validated server operation instead.
create or replace function public.kp_profile_customization_v14(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor text; whole jsonb; profile jsonb; rev bigint; tier int:=0;
  member_until timestamptz; membership text;
  prop text; choice text; required_tier int; allowed text[];
  image text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  if p_settings is null or jsonb_typeof(p_settings)<>'object' or length(p_settings::text)>250000 then
    raise exception 'Invalid customization payload';
  end if;
  if exists(select 1 from jsonb_object_keys(p_settings) as item(key)
    where item.key <> all(array[
      'nicknameEmoji','avatarFrame','profileBgEffect','profileCustomBg','chatBubbleStyle'
    ]::text[])) then
    raise exception 'Unsupported customization field';
  end if;

  select document,revision into whole,rev from public.kp_tree_roots
    where branch='users' for update;
  profile:=whole->actor;
  if profile is null then raise exception 'Profile missing'; end if;
  membership:=coalesce(profile->>'subscription','');
  member_until:=coalesce(nullif(profile->>'subscriptionExpiry','')::timestamptz,
    now()-interval '1 day');
  if member_until>now() then
    tier:=case membership when 'plus' then 1 when 'ultra' then 2 when 'prime' then 3 else 0 end;
  end if;
  if tier=0 then raise exception 'Active Plus subscription required'; end if;

  foreach prop in array array['avatarFrame','profileBgEffect','chatBubbleStyle'] loop
    if p_settings ? prop then
      choice:=coalesce(p_settings->>prop,'');
      required_tier:=0;
      if prop='avatarFrame' then
        allowed:=array['gold','pulse','neon','ice','forest_moss','nature_meadow'];
        if choice=any(array['rainbow','glow','fire','crystal','rose','plasma','thunder',
                            'hologram','dragon','forest_dusk','nature_aurora','wild_ember'])
        then required_tier:=2;
        elsif choice=any(array['prime','wild_storm']) then required_tier:=3;
        end if;
      elsif prop='profileBgEffect' then
        allowed:=array['shimmer','particles','ocean','sunset','forest_moss','nature_meadow'];
        if choice=any(array['gradient','aurora','galaxy','fire','plasma','thunder',
                            'hologram','dragon','forest_dusk','nature_aurora','wild_ember'])
        then required_tier:=2;
        elsif choice=any(array['prime','wild_storm','custom']) then required_tier:=3;
        end if;
      else
        allowed:=array['gold','ocean','sunset','neon','forest_moss','nature_meadow'];
        if choice=any(array['rainbow','aurora','galaxy','fire','rose',
                            'forest_dusk','nature_aurora','wild_ember'])
        then required_tier:=2;
        elsif choice=any(array['prime','wild_storm']) then required_tier:=3;
        end if;
      end if;
      if choice<>'' and choice<>all(allowed) and required_tier=0 then
        raise exception 'Unknown customization style';
      end if;
      if greatest(1,required_tier)>tier then
        raise exception 'This style requires a higher subscription';
      end if;
      profile:=jsonb_set(profile,array[prop],
        case when choice='' then 'null'::jsonb else to_jsonb(choice) end,true);
    end if;
  end loop;
  if p_settings ? 'nicknameEmoji' then
    choice:=coalesce(p_settings->>'nicknameEmoji','');
    if length(choice)>12 or choice ~ '[[:cntrl:]]' then
      raise exception 'Invalid nickname symbol';
    end if;
    profile:=jsonb_set(profile,'{nicknameEmoji}',
      case when choice='' then 'null'::jsonb else to_jsonb(choice) end,true);
  end if;
  if p_settings ? 'profileCustomBg' then
    image:=p_settings->>'profileCustomBg';
    if tier<3 or coalesce(profile->>'profileBgEffect','')<>'custom'
      or image is null or length(image)>240000
      or image !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' then
      raise exception 'Prime custom profile background required';
    end if;
    profile:=jsonb_set(profile,'{profileCustomBg}',to_jsonb(image),true);
  end if;
  if profile->>'profileBgEffect'='custom' and
    coalesce(profile->>'profileCustomBg','')='' then
    raise exception 'Choose a background image first';
  end if;

  whole:=jsonb_set(whole,array[actor],profile,true);
  update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.kp_profile_customization_v14(jsonb) from public,anon;
grant execute on function public.kp_profile_customization_v14(jsonb) to authenticated;

-- 0.3% after every full 24-hour interval, with compound interest. Remainders
-- below 1 ruble carry forward, so small accounts are not rounded to zero forever.
-- The *new* accrual clock starts on first v14 use. Old unearned periods do not
-- produce a windfall. Neither the browser nor a user can edit the clock.
create or replace function public.kp_savings_math_v14(p_profile jsonb,p_now_ms bigint)
returns jsonb language plpgsql immutable set search_path='' as $$
declare
  clock_ms bigint; days bigint; savings bigint; earned bigint:=0;
  per_day bigint; n bigint; carry numeric; due numeric;
begin
  clock_ms:=least(p_now_ms,greatest(0,
    coalesce((p_profile->>'savingsAccrualV14At')::bigint,p_now_ms)));
  days:=least(3650,greatest(0,(p_now_ms-clock_ms)/86400000));
  savings:=greatest(0,coalesce((p_profile->>'savingsBalance')::bigint,0));
  carry:=greatest(0,least(.999999,
    coalesce((p_profile->>'savingsInterestCarryV14')::numeric,0)));
  if days>0 then
    for n in 1..days loop
      if savings>=1000000000 then carry:=0; exit; end if;
      due:=savings*0.003+carry;
      per_day:=least(1000000000-savings,floor(due)::bigint);
      savings:=savings+per_day;
      earned:=earned+per_day;
      carry:=case when savings>=1000000000 then 0 else due-per_day end;
    end loop;
  end if;
  p_profile:=jsonb_set(p_profile,'{savingsBalance}',to_jsonb(savings),true);
  p_profile:=jsonb_set(p_profile,'{savingsAccrualV14At}',
    to_jsonb(clock_ms+days*86400000),true);
  p_profile:=jsonb_set(p_profile,'{savingsInterestCarryV14}',to_jsonb(carry),true);
  return jsonb_build_object('profile',p_profile,'savingsBalance',savings,
    'credited',earned,'days',days,'rate',0.003);
end;
$$;
revoke all on function public.kp_savings_math_v14(jsonb,bigint) from public,anon,authenticated;

create or replace function public.kp_savings_accrue_v14()
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor text; whole jsonb; profile jsonb; outcome jsonb; rev bigint;
  ms bigint; earned bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  select document,revision into whole,rev from public.kp_tree_roots
    where branch='users' for update;
  profile:=whole->actor;
  if profile is null then raise exception 'Profile missing'; end if;
  ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  outcome:=public.kp_savings_math_v14(profile,ms);
  earned:=(outcome->>'credited')::bigint;
  if not profile ? 'savingsAccrualV14At' or (outcome->>'days')::bigint>0 then
    whole:=jsonb_set(whole,array[actor],outcome->'profile',true);
    update public.kp_tree_roots set document=whole,revision=rev+1,updated_at=now()
      where branch='users';
    insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
      on conflict(branch) do update set revision=excluded.revision;
    if earned>0 then
      insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
        values(gen_random_uuid(),auth.uid(),'savings',earned,'savings_interest',
          jsonb_build_object('days',(outcome->>'days')::bigint,'dailyRate',0.003));
    end if;
  end if;
  return outcome-'profile'||jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.kp_savings_accrue_v14() from public,anon;
grant execute on function public.kp_savings_accrue_v14() to authenticated;

-- Every deposit/withdrawal accrues first while holding the same profile lock.
-- This blocks the race between withdrawal and the daily payout, and preserves
-- the pre-existing idempotency, wallet limits and savings ledger entry.
create or replace function public.kp_savings_move(
  p_direction text,p_amount bigint,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  nick text; root_doc jsonb; profile jsonb; rev bigint;
  balance_now bigint; savings bigint; movement bigint; outcome jsonb;
  earned bigint; day_count bigint; ms bigint;
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
  select balance into balance_now from public.kp_wallets
    where user_id=auth.uid() for update;
  if balance_now is null then raise exception 'Wallet missing'; end if;
  if exists(select 1 from public.kp_ledger where operation_id=p_request_id) then
    return jsonb_build_object('ok',true,'repeated',true,'balance',balance_now,
      'savingsBalance',greatest(0,coalesce((profile->>'savingsBalance')::bigint,0)));
  end if;
  ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  outcome:=public.kp_savings_math_v14(profile,ms);
  profile:=outcome->'profile';
  savings:=(outcome->>'savingsBalance')::bigint;
  earned:=(outcome->>'credited')::bigint;
  day_count:=(outcome->>'days')::bigint;

  if p_direction='deposit' then
    if coalesce(profile->>'accountFrozen','false')='true' or
      coalesce(profile->'roles'->>'migrant','false')='true' then
      raise exception 'Deposits disabled for this account'; end if;
    if balance_now<p_amount then raise exception 'Insufficient wallet funds'; end if;
    if savings+p_amount>1000000000 then raise exception 'Savings balance limit'; end if;
    movement:=-p_amount;savings:=savings+p_amount;
  else
    if savings<p_amount then raise exception 'Insufficient savings funds'; end if;
    if balance_now+p_amount>1000000000 then raise exception 'Wallet balance limit'; end if;
    movement:=p_amount;savings:=savings-p_amount;
  end if;
  balance_now:=balance_now+movement;
  update public.kp_wallets set balance=balance_now,updated_at=now()
    where user_id=auth.uid();
  if earned>0 then
    insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
      values(gen_random_uuid(),auth.uid(),'savings',earned,'savings_interest',
        jsonb_build_object('days',day_count,'dailyRate',0.003));
  end if;
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(p_request_id,auth.uid(),'wallet',movement,'savings_move',
      jsonb_build_object('direction',p_direction,'savings',savings));
  profile:=jsonb_set(profile,'{balance}',to_jsonb(balance_now),true);
  profile:=jsonb_set(profile,'{savingsBalance}',to_jsonb(savings),true);
  root_doc:=jsonb_set(root_doc,array[nick],profile,true);
  update public.kp_tree_roots set document=root_doc,revision=rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'balance',balance_now,
    'savingsBalance',savings,'interestCredited',earned);
end;
$$;
revoke all on function public.kp_savings_move(text,bigint,uuid) from public,anon;
grant execute on function public.kp_savings_move(text,bigint,uuid) to authenticated;

commit;
