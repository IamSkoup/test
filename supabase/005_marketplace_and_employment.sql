-- Verified marketplace transactions and municipal job applications.
-- Install AFTER 001-004. No direct client writes to either JSON tree.
begin;

create or replace function public.kp_job_application(
  p_action text, p_app_id text, p_target text default null, p_text text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor text; users_doc jsonb; user_doc jsonb; apps_doc jsonb; app jsonb;
  user_rev bigint; app_rev bigint; target_nick text; target_doc jsonb;
  req integer; score integer; max_jobs integer; jobs jsonb; job_item jsonb;
  job_count integer; active_sub boolean; entry record; moment bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  if p_action not in ('submit','withdraw','approve','reject') then
    raise exception 'Unsupported application action'; end if;
  if p_app_id is null or p_app_id !~ '^[A-Za-z0-9_-]{8,80}$' then
    raise exception 'Invalid application identifier'; end if;

  insert into public.kp_tree_roots(branch) values ('users'),('jobApps') on conflict do nothing;
  select document,revision into users_doc,user_rev from public.kp_tree_roots
    where branch='users' for update;
  select document,revision into apps_doc,app_rev from public.kp_tree_roots
    where branch='jobApps' for update;
  if p_action='submit' then
    if apps_doc ? p_app_id then raise exception 'Application already exists'; end if;
    if p_target not in ('Водитель','Доставщик','Уборщик','Журналист','КСБ',
      'Депутат','Полицейский','Рекламщик','Врач') then
      raise exception 'Unknown vacancy'; end if;
    if length(coalesce(p_text,''))>1200 then raise exception 'Application text too long'; end if;
    target_nick:=actor;
    user_doc:=users_doc->target_nick;
    if user_doc is null then raise exception 'Account missing'; end if;
    if coalesce(user_doc->'roles'->>'migrant','false')='true' then
      raise exception 'Job applications unavailable'; end if;
    if coalesce(user_doc->>'accountFrozen','false')='true' then
      raise exception 'Account frozen'; end if;
    for entry in select value from jsonb_each(coalesce(apps_doc,'{}'::jsonb)) loop
      if entry.value->>'from'=actor and entry.value->>'status'='new' then
        raise exception 'You already have a pending application'; end if;
    end loop;
  else
    app:=apps_doc->p_app_id;
    if app is null or app->>'status'<>'new' then
      raise exception 'Pending application missing'; end if;
    target_nick:=app->>'from';
    if p_action='withdraw' then
      if actor<>target_nick then raise exception 'Only applicant may withdraw'; end if;
    elsif actor<>'Кайон' then
      raise exception 'Mayor access required';
    end if;
    user_doc:=users_doc->target_nick;
    if user_doc is null then raise exception 'Applicant profile missing'; end if;
    p_target:=app->>'target';
  end if;

  if p_action in ('submit','approve') then
    req:=case p_target
      when 'Водитель' then 60 when 'Доставщик' then 53
      when 'Уборщик' then 40 when 'Журналист' then 71
      when 'КСБ' then 90 when 'Депутат' then 95
      when 'Полицейский' then 80 when 'Врач' then 90
      when 'Рекламщик' then 50 else 101 end;
    if user_doc->>'kveScore' is null then raise exception 'KVE score not assigned'; end if;
    score:=(user_doc->>'kveScore')::integer;
    if score<req then raise exception 'Insufficient KVE score for vacancy'; end if;
    jobs:=coalesce(user_doc->'employments','[]'::jsonb);
    if jsonb_typeof(jobs)<>'array' then jobs:='[]'::jsonb; end if;
    job_count:=jsonb_array_length(jobs);
    if user_doc->>'job' is not null and user_doc->>'job'<>'Житель'
      and not exists(select 1 from jsonb_array_elements(jobs) j
        where j->>'id'='muni_'||(user_doc->>'job')) then
      job_count:=job_count+1;
    end if;
    if exists(select 1 from jsonb_array_elements(jobs) j
      where j->>'id'='muni_'||p_target) or user_doc->>'job'=p_target then
      raise exception 'Already employed in this role'; end if;
    active_sub:=coalesce((user_doc->>'subscriptionExpiry')::timestamptz,
      now()-interval '1 day')>now();
    max_jobs:=case when active_sub and user_doc->>'subscription'='prime' then 5
      when active_sub and user_doc->>'subscription'='ultra' then 4
      when active_sub and user_doc->>'subscription'='plus' then 3 else 2 end;
    if job_count>=max_jobs then raise exception 'Employment limit reached'; end if;
  end if;

  moment:=(extract(epoch from clock_timestamp())*1000)::bigint;
  if p_action='submit' then
    app:=jsonb_build_object('id',p_app_id,'from',actor,'target',p_target,
      'status','new','appText',trim(coalesce(p_text,'')),'kveScore',score,
      'createdAt',moment);
    apps_doc:=jsonb_set(apps_doc,array[p_app_id],app,true);
  elsif p_action='withdraw' then
    apps_doc:=apps_doc-p_app_id;
  elsif p_action='reject' then
    apps_doc:=jsonb_set(apps_doc,array[p_app_id,'status'],'"rejected"'::jsonb,true);
    apps_doc:=jsonb_set(apps_doc,array[p_app_id,'reviewedAt'],to_jsonb(moment),true);
  elsif p_action='approve' then
    jobs:=jobs||jsonb_build_array(jsonb_build_object('id','muni_'||p_target,
      'type','municipal','role',p_target));
    user_doc:=user_doc||jsonb_build_object('job',p_target,'vehicle','',
      'employments',jobs,'displayJob',coalesce(nullif(user_doc->>'displayJob',''),p_target));
    if p_target='Уборщик' then
      user_doc:=user_doc||jsonb_build_object('janitorSubmissionStatus','ready',
        'janitorSubmissionId','','janitorProof','','janitorComment','');
    end if;
    users_doc:=jsonb_set(users_doc,array[target_nick],user_doc,true);
    apps_doc:=jsonb_set(apps_doc,array[p_app_id,'status'],'"approved"'::jsonb,true);
    apps_doc:=jsonb_set(apps_doc,array[p_app_id,'reviewedAt'],to_jsonb(moment),true);
    update public.kp_tree_roots set document=users_doc,revision=user_rev+1,updated_at=now()
      where branch='users';
    insert into public.kp_tree_revisions(branch,revision) values('users',user_rev+1)
      on conflict(branch) do update set revision=excluded.revision;
  end if;
  update public.kp_tree_roots set document=apps_doc,revision=app_rev+1,updated_at=now()
    where branch='jobApps';
  insert into public.kp_tree_revisions(branch,revision) values('jobApps',app_rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'action',p_action,'id',p_app_id);
end;
$$;
revoke all on function public.kp_job_application(text,text,text,text) from public,anon;
grant execute on function public.kp_job_application(text,text,text,text) to authenticated;

create or replace function public.kp_market_action(
  p_action text, p_listing_id text, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor text; buyer text; seller text; cat text; status_now text;
  users_doc jsonb; actor_doc jsonb; buyer_doc jsonb; seller_doc jsonb;
  market_doc jsonb; listing_doc jsonb; treasury_doc jsonb;
  user_rev bigint; market_rev bigint; treasury_rev bigint;
  title text; descr text; photo text; salary_hint text; subscription text;
  week_key text; is_neg boolean; active_sub boolean; is_prime boolean;
  allowed_count integer; used_count integer; price bigint; fee bigint;
  buyer_balance bigint; seller_balance bigint; pin_price bigint; amount bigint;
  buyer_uid uuid; seller_uid uuid; moment bigint; payment_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  if p_action not in ('create','request','confirm','cancel','decline','purchase',
                      'pin','archive','restore','delete') then
    raise exception 'Unknown marketplace action'; end if;
  if p_listing_id is null or p_listing_id !~ '^[A-Za-z0-9_-]{8,80}$' then
    raise exception 'Invalid listing ID'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'Invalid request'; end if;
  insert into public.kp_tree_roots(branch) values('users'),('marketplace')
    on conflict do nothing;
  select document,revision into users_doc,user_rev from public.kp_tree_roots
    where branch='users' for update;
  actor_doc:=users_doc->actor;
  if actor_doc is null then raise exception 'Account data missing'; end if;
  if coalesce(actor_doc->'roles'->>'migrant','false')='true' or
    coalesce(actor_doc->>'accountFrozen','false')='true' then
    raise exception 'Marketplace access unavailable'; end if;
  if p_action in ('create','request','purchase','pin') then
    if coalesce(actor_doc->>'accountVerified','false')<>'true' then
      raise exception 'Account not verified by mayor'; end if;
    select balance into buyer_balance from public.kp_wallets where user_id=auth.uid();
    if buyer_balance is null or buyer_balance<0 then
      raise exception 'Marketplace blocked for an account in debt'; end if;
  end if;
  select document,revision into market_doc,market_rev from public.kp_tree_roots
    where branch='marketplace' for update;
  moment:=(extract(epoch from clock_timestamp())*1000)::bigint;
  if p_action='create' then
    if market_doc ? p_listing_id then raise exception 'Listing already exists'; end if;
    title:=trim(coalesce(p_payload->>'title',''));
    descr:=trim(coalesce(p_payload->>'desc',''));
    photo:=coalesce(p_payload->>'photo','');
    cat:=p_payload->>'category';
    salary_hint:=trim(coalesce(p_payload->>'salaryHint',''));
    is_neg:=coalesce((p_payload->>'priceNegotiable')::boolean,false);
    if coalesce(p_payload->>'price','') !~ '^[0-9]{1,7}$' then raise exception 'Invalid price'; end if;
    price:=(p_payload->>'price')::bigint;
    if cat not in ('other','food','tools','clothes','electronics','building',
                   'work','service') or length(title) not between 2 and 120 or
      length(descr)>2000 or length(photo)>2500000 or length(salary_hint)>160 then
      raise exception 'Invalid listing details'; end if;
    if cat='work' then
      if salary_hint='' then raise exception 'Vacancy compensation required'; end if;
      price:=0; is_neg:=false;
    elsif not is_neg and price<=0 then
      raise exception 'Price must be positive'; end if;
    active_sub:=coalesce((actor_doc->>'subscriptionExpiry')::timestamptz,
      now()-interval '1 day')>now();
    subscription:=case when active_sub then actor_doc->>'subscription' else 'none' end;
    allowed_count:=case subscription when 'prime' then 999999
      when 'ultra' then 8 when 'plus' then 4 else 2 end;
    week_key:=to_char(now() at time zone 'Europe/Moscow','IYYY-"W"IW');
    used_count:=case when actor_doc->>'lastListingWeek'=week_key
      then greatest(0,coalesce((actor_doc->>'listingsThisWeek')::integer,0)) else 0 end;
    if used_count>=allowed_count then raise exception 'Weekly listing limit reached'; end if;
    listing_doc:=jsonb_build_object('id',p_listing_id,'seller',actor,'title',title,
      'desc',descr,'photo',photo,'price',price,'priceNegotiable',is_neg,
      'salaryHint',salary_hint,'category',cat,'status','active','buyer',null);
    market_doc:=jsonb_set(market_doc,array[p_listing_id],listing_doc,true);
    actor_doc:=actor_doc||jsonb_build_object('listingsThisWeek',used_count+1,
      'lastListingWeek',week_key);
    users_doc:=jsonb_set(users_doc,array[actor],actor_doc,true);
  else
    listing_doc:=market_doc->p_listing_id;
    if listing_doc is null then raise exception 'Listing not found'; end if;
    buyer:=listing_doc->>'buyer'; seller:=listing_doc->>'seller';
    status_now:=listing_doc->>'status'; cat:=listing_doc->>'category';
    if p_action='request' then
      if actor=seller or status_now<>'active' or
        coalesce(listing_doc->>'archived','false')='true' then
        raise exception 'Listing cannot receive requests'; end if;
      listing_doc:=listing_doc||jsonb_build_object('status','meeting_requested','buyer',actor);
    elsif p_action='confirm' then
      if actor<>seller or status_now<>'meeting_requested' then
        raise exception 'Only seller can confirm pending request'; end if;
      listing_doc:=jsonb_set(listing_doc,'{status}','"meeting_confirmed"'::jsonb,true);
    elsif p_action='decline' then
      if actor<>seller or status_now<>'meeting_requested' then
        raise exception 'Only seller can reject request'; end if;
      listing_doc:=listing_doc||jsonb_build_object('status','active','buyer',null);
    elsif p_action='cancel' then
      if actor not in (seller,buyer) or status_now not in ('meeting_requested','meeting_confirmed') then
        raise exception 'No active request to cancel'; end if;
      listing_doc:=listing_doc||jsonb_build_object('status','active','buyer',null);
    elsif p_action='archive' or p_action='restore' then
      if actor<>seller then raise exception 'Only seller can edit listing'; end if;
      if p_action='archive' then
        listing_doc:=listing_doc||jsonb_build_object('archived',true,'archivedAt',moment);
      else
        listing_doc:=listing_doc-'archived'-'archivedAt';
      end if;
    elsif p_action='delete' then
      if actor<>seller then raise exception 'Only seller can delete listing'; end if;
      market_doc:=market_doc-p_listing_id;
    elsif p_action='pin' then
      if actor<>seller or coalesce(listing_doc->>'archived','false')='true'
        or coalesce((listing_doc->>'pinnedUntil')::bigint,0)>moment then
        raise exception 'Listing cannot be pinned'; end if;
      active_sub:=coalesce((actor_doc->>'subscriptionExpiry')::timestamptz,
        now()-interval '1 day')>now();
      is_prime:=active_sub and actor_doc->>'subscription'='prime';
      pin_price:=case when is_prime then 0 else 160 end;
      if pin_price>0 then
        select balance into buyer_balance from public.kp_wallets
          where user_id=auth.uid() for update;
        if buyer_balance is null or buyer_balance<pin_price then
          raise exception 'Not enough funds to promote listing'; end if;
        update public.kp_wallets set balance=balance-pin_price,updated_at=now()
          where user_id=auth.uid();
        insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
          values(gen_random_uuid(),auth.uid(),'wallet',-pin_price,'market_pin',
            jsonb_build_object('listingId',p_listing_id));
        actor_doc:=jsonb_set(actor_doc,'{balance}',to_jsonb(buyer_balance-pin_price),true);
        users_doc:=jsonb_set(users_doc,array[actor],actor_doc,true);
      end if;
      listing_doc:=listing_doc||jsonb_build_object('pinnedUntil',moment+604800000,
        'pinnedBy',actor,'pinnedLabel',case when is_prime then 'ХИТ ПРОДАЖ!'
        else 'Лидер продаж!' end);
    elsif p_action='purchase' then
      if actor<>buyer or status_now<>'meeting_confirmed' or
        coalesce(listing_doc->>'archived','false')='true' then
        raise exception 'Purchase has not been confirmed by seller'; end if;
      if cat='work' then
        listing_doc:=listing_doc||jsonb_build_object('status','active','buyer',null,
          'workAcceptedBy',actor,'workAcceptedAt',moment);
      else
        if coalesce(listing_doc->>'priceNegotiable','false')='true' then
          if coalesce(p_payload->>'amount','') !~ '^[0-9]{1,7}$' then
            raise exception 'Invalid agreed price'; end if;
          amount:=(p_payload->>'amount')::bigint;
        else
          amount:=(listing_doc->>'price')::bigint;
        end if;
        if amount<0 or amount>1000000 then raise exception 'Invalid purchase amount'; end if;
        fee:=case when amount=0 then 0 else greatest(1,round(amount*0.02)::bigint) end;
        select user_id into buyer_uid from public.kp_profiles where nickname=buyer;
        select user_id into seller_uid from public.kp_profiles where nickname=seller;
        if buyer_uid is null or seller_uid is null or buyer_uid=seller_uid then
          raise exception 'Invalid participants'; end if;
        buyer_doc:=users_doc->buyer; seller_doc:=users_doc->seller;
        if buyer_doc is null or seller_doc is null then
          raise exception 'Participant missing'; end if;
        perform 1 from public.kp_wallets where user_id in (buyer_uid,seller_uid)
          order by user_id for update;
        select balance into buyer_balance from public.kp_wallets where user_id=buyer_uid;
        select balance into seller_balance from public.kp_wallets where user_id=seller_uid;
        if buyer_balance is null or seller_balance is null then
          raise exception 'Wallet missing'; end if;
        if buyer_balance<amount+fee then raise exception 'Insufficient funds including fee'; end if;
        if seller_balance+amount>1000000000 then raise exception 'Seller wallet limit'; end if;
        update public.kp_wallets set balance=balance-amount-fee,updated_at=now()
          where user_id=buyer_uid;
        update public.kp_wallets set balance=balance+amount,updated_at=now()
          where user_id=seller_uid;
        payment_id:=gen_random_uuid();
        insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
          values(payment_id,buyer_uid,'wallet',-amount-fee,'market_purchase',
            jsonb_build_object('listingId',p_listing_id,'seller',seller,'fee',fee));
        insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
          values(gen_random_uuid(),seller_uid,'wallet',amount,'market_sale',
            jsonb_build_object('listingId',p_listing_id,'buyer',buyer));
        buyer_doc:=jsonb_set(buyer_doc,'{balance}',to_jsonb(buyer_balance-amount-fee),true);
        seller_doc:=jsonb_set(seller_doc,'{balance}',to_jsonb(seller_balance+amount),true);
        users_doc:=jsonb_set(users_doc,array[buyer],buyer_doc,true);
        users_doc:=jsonb_set(users_doc,array[seller],seller_doc,true);
        if fee>0 then
          insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
          select document,revision into treasury_doc,treasury_rev from public.kp_tree_roots
            where branch='municipalTreasury' for update;
          treasury_doc:=jsonb_set(treasury_doc,'{balance}',
            to_jsonb(coalesce((treasury_doc->>'balance')::bigint,0)+fee),true);
          update public.kp_tree_roots set document=treasury_doc,revision=treasury_rev+1,updated_at=now()
            where branch='municipalTreasury';
          insert into public.kp_tree_revisions(branch,revision)
            values('municipalTreasury',treasury_rev+1)
            on conflict(branch) do update set revision=excluded.revision;
        end if;
        if cat='service' then
          listing_doc:=listing_doc||jsonb_build_object('status','active','buyer',null);
        else
          listing_doc:=jsonb_set(listing_doc,'{status}','"sold"'::jsonb,true);
        end if;
      end if;
    end if;
    if p_action<>'delete' then
      market_doc:=jsonb_set(market_doc,array[p_listing_id],listing_doc,true);
    end if;
  end if;
  update public.kp_tree_roots set document=market_doc,revision=market_rev+1,updated_at=now()
    where branch='marketplace';
  insert into public.kp_tree_revisions(branch,revision) values('marketplace',market_rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  if p_action in ('create','purchase','pin') then
    update public.kp_tree_roots set document=users_doc,revision=user_rev+1,updated_at=now()
      where branch='users';
    insert into public.kp_tree_revisions(branch,revision) values('users',user_rev+1)
      on conflict(branch) do update set revision=excluded.revision;
  end if;
  return jsonb_build_object('ok',true,'action',p_action,'listingId',p_listing_id,
    'amount',amount,'commission',fee);
end;
$$;
revoke all on function public.kp_market_action(text,text,jsonb) from public,anon;
grant execute on function public.kp_market_action(text,text,jsonb) to authenticated;

create or replace function public.kp_rent_listing_action(
  p_action text, p_listing_id text, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; users_doc jsonb; profile jsonb; rentals jsonb; rev bigint;
  title text; description text; address_line text; photo text; price bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  if p_action not in ('create','delete') or
    p_listing_id is null or p_listing_id !~ '^[A-Za-z0-9_-]{8,80}$' then
    raise exception 'Invalid rental operation'; end if;
  select document into users_doc from public.kp_tree_roots where branch='users';
  profile:=users_doc->actor;
  if profile is null or coalesce(profile->'roles'->>'migrant','false')='true'
    or coalesce(profile->>'accountFrozen','false')='true' then
    raise exception 'Rental access unavailable'; end if;
  insert into public.kp_tree_roots(branch) values('marketRentals') on conflict do nothing;
  select document,revision into rentals,rev from public.kp_tree_roots
    where branch='marketRentals' for update;
  if p_action='create' then
    if rentals ? p_listing_id then raise exception 'Rental ID already exists'; end if;
    title:=trim(coalesce(p_payload->>'title',''));
    description:=trim(coalesce(p_payload->>'desc',''));
    address_line:=trim(coalesce(p_payload->>'address',''));
    photo:=trim(coalesce(p_payload->>'photo',''));
    if coalesce(p_payload->>'price','') !~ '^[0-9]{1,7}$' then raise exception 'Invalid rental price'; end if;
    price:=(p_payload->>'price')::bigint;
    if price<1 or price>1000000 or length(title) not between 2 and 80 or
      length(description) not between 2 and 500 or length(address_line)>120 or
      length(photo)>4000 then raise exception 'Invalid rental details'; end if;
    rentals:=jsonb_set(rentals,array[p_listing_id],jsonb_build_object('id',p_listing_id,
      'owner',actor,'title',title,'price',price,'address',address_line,
      'desc',description,'photo',photo,'status','active',
      'createdAt',(extract(epoch from clock_timestamp())*1000)::bigint),true);
  else
    if rentals->p_listing_id->>'owner' is distinct from actor then
      raise exception 'Only owner can remove rental'; end if;
    rentals:=rentals-p_listing_id;
  end if;
  update public.kp_tree_roots set document=rentals,revision=rev+1,updated_at=now()
    where branch='marketRentals';
  insert into public.kp_tree_revisions(branch,revision) values('marketRentals',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'action',p_action);
end;
$$;
revoke all on function public.kp_rent_listing_action(text,text,jsonb) from public,anon;
grant execute on function public.kp_rent_listing_action(text,text,jsonb) to authenticated;

create or replace function public.kp_business_promote(p_business_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text; users_doc jsonb; user_doc jsonb; businesses jsonb;
  item jsonb; u_rev bigint; b_rev bigint; wallet_balance bigint;
  moment bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  if p_business_id is null or length(p_business_id)>80 then
    raise exception 'Invalid business ID'; end if;
  insert into public.kp_tree_roots(branch) values('users'),('businesses') on conflict do nothing;
  select document,revision into users_doc,u_rev from public.kp_tree_roots
    where branch='users' for update;
  user_doc:=users_doc->actor;
  if user_doc is null or coalesce(user_doc->>'accountFrozen','false')='true'
    or coalesce(user_doc->'roles'->>'migrant','false')='true' then
    raise exception 'Account cannot promote a business'; end if;
  if user_doc->>'subscription'<>'prime' or
    coalesce((user_doc->>'subscriptionExpiry')::timestamptz,
      now()-interval '1 day')<=now() then
    raise exception 'Prime subscription required'; end if;
  select document,revision into businesses,b_rev from public.kp_tree_roots
    where branch='businesses' for update;
  item:=businesses->p_business_id;
  moment:=(extract(epoch from clock_timestamp())*1000)::bigint;
  if item is null or item->>'owner'<>actor or
    coalesce((item->>'promotedUntil')::bigint,0)>moment then
    raise exception 'Business not eligible for promotion'; end if;
  select balance into wallet_balance from public.kp_wallets
    where user_id=auth.uid() for update;
  if wallet_balance is null or wallet_balance<600 then
    raise exception 'Insufficient funds for promotion'; end if;
  update public.kp_wallets set balance=balance-600,updated_at=now()
    where user_id=auth.uid();
  insert into public.kp_ledger(operation_id,user_id,account,amount,kind,details)
    values(gen_random_uuid(),auth.uid(),'wallet',-600,'business_promotion',
      jsonb_build_object('businessId',p_business_id));
  user_doc:=jsonb_set(user_doc,'{balance}',to_jsonb(wallet_balance-600),true);
  users_doc:=jsonb_set(users_doc,array[actor],user_doc,true);
  businesses:=jsonb_set(businesses,array[p_business_id,'promotedUntil'],
    to_jsonb(moment+604800000),true);
  update public.kp_tree_roots set document=users_doc,revision=u_rev+1,updated_at=now()
    where branch='users';
  update public.kp_tree_roots set document=businesses,revision=b_rev+1,updated_at=now()
    where branch='businesses';
  insert into public.kp_tree_revisions(branch,revision)
    values('users',u_rev+1),('businesses',b_rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('ok',true,'promotedUntil',moment+604800000);
end;
$$;
revoke all on function public.kp_business_promote(text) from public,anon;
grant execute on function public.kp_business_promote(text) to authenticated;

-- Taxi history is protected because its root also contains trips by other
-- residents. The browser receives ONLY journeys belonging to its session.
create or replace function public.kp_my_taxi_history()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor text; history_doc jsonb; result jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  select document into history_doc from public.kp_tree_roots where branch='taxiHistory';
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into result
    from jsonb_each(coalesce(history_doc,'{}'::jsonb))
    where value->>'client'=actor;
  return coalesce(result,'{}'::jsonb);
end;
$$;
revoke all on function public.kp_my_taxi_history() from public,anon;
grant execute on function public.kp_my_taxi_history() to authenticated;

-- Public hospital catalog, plus appointment details only for the patient.
-- Doctor/assistant administration must use separately authorized operations.
create or replace function public.kp_hospital_view()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor text; source_doc jsonb; own_appointments jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor from public.kp_profiles where user_id=auth.uid();
  if actor is null then raise exception 'Profile missing'; end if;
  select document into source_doc from public.kp_tree_roots where branch='hospital';
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into own_appointments
    from jsonb_each(coalesce(source_doc->'appointments','{}'::jsonb))
    where value->>'clientNick'=actor;
  return jsonb_build_object('services',coalesce(source_doc->'services','{}'::jsonb),
    'photos',coalesce(source_doc->'photos','{}'::jsonb),
    'appointments',coalesce(own_appointments,'{}'::jsonb));
end;
$$;
revoke all on function public.kp_hospital_view() from public,anon;
grant execute on function public.kp_hospital_view() to authenticated;

-- The old bank UI used users/<nick>/txlog, but protected transfers are
-- recorded in kp_ledger. Return exclusively the caller's ledger entries
-- plus their older, own-account txlog entries for a seamless history.
create or replace function public.kp_my_transactions()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  actor text; users_doc jsonb; legacy jsonb; result jsonb:='[]'::jsonb;
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
    meta:=to_jsonb(entry);
    details:=coalesce(meta->'details','{}'::jsonb);
    amount_value:=coalesce((meta->>'amount')::bigint,0);
    kind_name:=coalesce(meta->>'kind','operation');
    action_type:=case when amount_value<0 then 'out' else 'in' end;
    raw_time:=coalesce(meta->>'created_at',meta->>'createdAt','');
    row_time:=null;
    if raw_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then
      row_time:=raw_time::timestamptz;
    elsif raw_time ~ '^[0-9]{12,13}$' then
      row_time:=to_timestamp(raw_time::numeric/1000);
    end if;
    who_name:=case kind_name
      when 'bank_transfer' then coalesce(details->>'to',details->>'from','Житель')
      when 'mayor_adjustment' then 'Мэрия'
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
      'id',coalesce(meta->>'operation_id',''),
      'type',action_type,'amt',abs(amount_value),'who',who_name,'desc',description,
      'ts',case when row_time is not null then to_char(row_time at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"') else '' end,
      'date',case when row_time is not null then to_char(row_time at time zone
        'Europe/Moscow','DD.MM.YYYY') else '' end,
      'time',case when row_time is not null then to_char(row_time at time zone
        'Europe/Moscow','HH24:MI') else '' end
    ));
  end loop;
  select document->actor->'txlog' into legacy from public.kp_tree_roots
    where branch='users';
  if jsonb_typeof(legacy)='object' then
    result:=result||coalesce((select jsonb_agg(value) from jsonb_each(legacy)),
      '[]'::jsonb);
  end if;
  return result;
end;
$$;
revoke all on function public.kp_my_transactions() from public,anon;
grant execute on function public.kp_my_transactions() to authenticated;

-- Replace the old marketplace achievement check that required an obsolete
-- 'orders/type=market' record. A completed, server-written wallet ledger
-- entry is reliable proof of a paid marketplace purchase.
create or replace function public.kp_claim_migrated_once(p_task_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare nick text; users jsonb; user_doc jsonb; rev bigint; reward integer;
  allowed boolean:=false; evidence jsonb;
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
    select exists(select 1 from public.kp_ledger l where l.user_id=auth.uid()
      and l.kind='market_purchase' and l.amount<0) into allowed;
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

-- Verify privileges after deployment:
-- select proname,has_function_privilege('anon',oid,'EXECUTE') anon,
-- has_function_privilege('authenticated',oid,'EXECUTE') member
-- from pg_proc where proname in ('kp_market_action','kp_job_application');
commit;
