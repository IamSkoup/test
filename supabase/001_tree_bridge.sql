-- Kapani legacy data bridge. Safe to run alongside the existing kp_* schema.
-- The real wallet, ledger and roles remain in the dedicated protected tables.
begin;

create table if not exists public.kp_tree_roots (
  branch text primary key check (branch ~ '^[A-Za-z][A-Za-z0-9_]*$'),
  document jsonb not null default '{}'::jsonb,
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.kp_tree_roots enable row level security;
revoke all on public.kp_tree_roots from anon, authenticated;

create table if not exists public.kp_tree_revisions (
  branch text primary key,
  revision bigint not null default 0
);
alter table public.kp_tree_revisions enable row level security;
drop policy if exists kp_tree_revisions_read on public.kp_tree_revisions;
create policy kp_tree_revisions_read on public.kp_tree_revisions for select
  to anon, authenticated using (true);
grant select on public.kp_tree_revisions to anon, authenticated;

create or replace function public.kp_tree_set_deep(doc jsonb, keys text[], val jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select case when cardinality(keys) = 0 then val
    when cardinality(keys) = 1 then
      jsonb_set(coalesce(doc,'{}'::jsonb),keys, val, true)
    else jsonb_set(coalesce(doc,'{}'::jsonb),array[keys[1]],
      public.kp_tree_set_deep(coalesce(doc->keys[1],'{}'::jsonb),keys[2:cardinality(keys)],val),true)
  end;
$$;
revoke all on function public.kp_tree_set_deep(jsonb,text[],jsonb) from public;

create or replace function public.kp_tree_access(
  p_operation text,
  p_path text default '',
  p_payload jsonb default null,
  p_expected_revision bigint default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  parts text[];
  top_branch text;
  subtree text[];
  stored jsonb;
  old_value jsonb;
  new_value jsonb;
  result jsonb;
  rev bigint;
  actor_nick text;
  target_nick text;
  is_staff boolean;
  sensitive text[] := array[
    'balance','savingsBalance','taskBalance','casino','casinoBalance',
    'accountVerified','accountFrozen','job','roles','subscriptions','subscription',
    'subscriptionExpiry','totalEarned','advertiserWeekly','txlog',
    'passwordHash','passwordHashSalt','referralCode','licenses',
    'weeklySalary','salary','isAdmin','isMayor','prime','ultra'
  ];
  protected text;
begin
  if p_path is null or length(p_path) > 400 or p_path ~ '[[:cntrl:]]' then
    raise exception 'Invalid tree path';
  end if;
  parts := string_to_array(trim(both '/' from p_path), '/');
  parts := array_remove(parts, '');
  top_branch := parts[1];
  subtree := case when cardinality(parts) > 1 then parts[2:cardinality(parts)] else array[]::text[] end;

  if p_operation = 'read' then
    if top_branch is null then
      if auth.uid() is null then return '{}'::jsonb; end if;
      select coalesce(jsonb_object_agg(branch, document), '{}'::jsonb)
        into result from public.kp_tree_roots;
      return jsonb_build_object('value', result, 'revision', 0);
    end if;
    if auth.uid() is null and top_branch <> 'users' then
      return jsonb_build_object('value', null, 'revision', 0);
    end if;
    select document, revision into stored, rev from public.kp_tree_roots where branch = top_branch;
    if stored is null then stored := '{}'::jsonb; rev := 0; end if;
    result := case when cardinality(subtree) > 0 then stored #> subtree else stored end;
    if top_branch = 'users' then
      -- A legacy profile is never a credential database. Do not return hashes.
      if cardinality(subtree) = 0 then
        select coalesce(jsonb_object_agg(key,
          case when auth.uid() is null then jsonb_build_object('nick',key,'displayName',value->>'displayName')
          else value - 'passwordHash' - 'passwordHashSalt' end), '{}'::jsonb)
          into result from jsonb_each(coalesce(stored,'{}'::jsonb));
      elsif cardinality(subtree) = 1 and result is not null then
        result := case when auth.uid() is null then
          jsonb_build_object('nick',subtree[1],'displayName',result->>'displayName')
          else result - 'passwordHash' - 'passwordHashSalt' end;
      elsif subtree[array_length(subtree,1)] in ('passwordHash','passwordHashSalt') then
        result := null;
      end if;
    end if;
    return jsonb_build_object('value', result, 'revision', rev);
  end if;

  if p_operation not in ('set','remove','update') then
    raise exception 'Unsupported tree operation';
  end if;
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select nickname into actor_nick from public.kp_profiles where user_id = auth.uid();
  if actor_nick is null then raise exception 'Profile registration required'; end if;
  if top_branch is null or cardinality(parts) > 12 or top_branch !~ '^[A-Za-z][A-Za-z0-9_]*$' then
    raise exception 'Invalid write path';
  end if;
  select exists (
    select 1 from public.kp_roles where user_id = auth.uid() and role in ('admin','mayor')
  ) into is_staff;

  if top_branch in ('pushOutbox','municipalTreasury','adminForceHireLog','advertiserStats',
                    'wallets','ledger','kp_wallets','kp_roles') then
    raise exception 'This data can only be changed by a trusted server operation';
  end if;

  if top_branch = 'users' then
    target_nick := subtree[1];
    if target_nick is null or (target_nick <> actor_nick and not is_staff) then
      raise exception 'Cannot modify another user';
    end if;
    if not is_staff then
      if cardinality(subtree) > 1 and subtree[2] = any(sensitive) then
        raise exception 'Protected account field';
      end if;
      if p_operation = 'update' and cardinality(subtree) = 1 and jsonb_typeof(p_payload) = 'object' then
        if exists(select 1 from jsonb_object_keys(p_payload) as key where key = any(sensitive)) then
          raise exception 'Protected account field';
        end if;
      end if;
    end if;
  elsif top_branch = 'notifications' then
    raise exception 'Use the notification service';
  elsif top_branch = 'chat' and p_operation <> 'remove' then
    if cardinality(subtree) <> 1 or (p_operation = 'set' and p_payload->>'nick' <> actor_nick) then
      raise exception 'Chat message author mismatch';
    end if;
  elsif top_branch = 'dms' then
    if not (position(actor_nick in coalesce(subtree[1],'')) > 0) then
      raise exception 'Not a DM participant';
    end if;
    if cardinality(subtree) >= 3 and subtree[2] = 'messages'
       and p_operation = 'set' and p_payload->>'nick' <> actor_nick then
      raise exception 'DM message author mismatch';
    end if;
  elsif top_branch in ('dmIndex','presence','readState','typing','walls') then
    if subtree[1] <> actor_nick and not is_staff then
      -- Typing/dm has a combined conversation key, validated separately.
      if top_branch <> 'typing' then raise exception 'Cannot edit another user view'; end if;
    end if;
  end if;

  insert into public.kp_tree_roots(branch) values(top_branch) on conflict do nothing;
  select document, revision into stored, rev from public.kp_tree_roots
    where branch = top_branch for update;
  if p_expected_revision is not null and rev <> p_expected_revision then
    return jsonb_build_object('conflict',true,'revision',rev);
  end if;
  old_value := case when cardinality(subtree) = 0 then stored else stored #> subtree end;
  if p_operation = 'set' then
    new_value := p_payload;
  elsif p_operation = 'remove' then
    new_value := null;
  else
    if jsonb_typeof(p_payload) <> 'object' then raise exception 'Expected JSON object for update'; end if;
    new_value := coalesce(old_value,'{}'::jsonb) || p_payload;
  end if;

  -- User-level replacements are common in the old code. Never let one smuggle
  -- money, roles or privileges through a full-object transaction.
  if top_branch = 'users' and not is_staff and cardinality(subtree) = 1 then
    if old_value is null then
      if coalesce((new_value->>'balance')::numeric,0) <> 0
         or coalesce((new_value->>'taskBalance')::numeric,0) <> 0
         or coalesce((new_value->>'savingsBalance')::numeric,0) <> 0
         or coalesce(new_value->>'job','Житель') <> 'Житель'
         or coalesce((new_value->>'accountVerified')::boolean,false) then
        raise exception 'Invalid initial account state';
      end if;
    else
      foreach protected in array sensitive loop
        if old_value->protected is distinct from new_value->protected then
          raise exception 'Protected field %',protected;
        end if;
      end loop;
    end if;
  end if;

  if cardinality(subtree) = 0 then
    stored := coalesce(new_value,'{}'::jsonb);
  elsif p_operation = 'remove' then
    stored := stored #- subtree;
  else
    stored := public.kp_tree_set_deep(stored,subtree,coalesce(new_value,'null'::jsonb));
  end if;
  update public.kp_tree_roots set document=stored, revision=rev+1, updated_at=now()
    where branch=top_branch;
  insert into public.kp_tree_revisions(branch,revision) values(top_branch,rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return jsonb_build_object('value',new_value,'revision',rev+1,'committed',true);
end;
$$;

revoke all on function public.kp_tree_access(text,text,jsonb,bigint) from public;
grant execute on function public.kp_tree_access(text,text,jsonb,bigint) to anon,authenticated;

do $$ begin
  if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='kp_tree_revisions') then
    alter publication supabase_realtime add table public.kp_tree_revisions;
  end if;
end $$;

-- Media is public-readable, but uploading requires an authenticated session,
-- and a user may write only under their own UUID directory.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('kapani-media','kapani-media',true,51380224,
    array['image/jpeg','image/png','image/webp','image/gif','video/mp4',
          'video/webm','video/quicktime','audio/webm','audio/ogg','audio/mp4','audio/mpeg'])
  on conflict(id) do update set public=true,file_size_limit=51380224;
drop policy if exists kp_media_insert on storage.objects;
create policy kp_media_insert on storage.objects for insert to authenticated
  with check (bucket_id='kapani-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists kp_media_read on storage.objects;
create policy kp_media_read on storage.objects for select to anon,authenticated
  using (bucket_id='kapani-media');
drop policy if exists kp_media_delete on storage.objects;
create policy kp_media_delete on storage.objects for delete to authenticated
  using (bucket_id='kapani-media' and (storage.foldername(name))[1]=auth.uid()::text);

create table if not exists public.kp_push_devices (
  subscription_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  prefs jsonb not null default '{}'::jsonb,
  user_agent text,
  updated_at timestamptz not null default now()
);
create index if not exists kp_push_devices_user on public.kp_push_devices(user_id);
alter table public.kp_push_devices enable row level security;
revoke all on public.kp_push_devices from anon,authenticated;

-- Invoked only by the Supabase Edge Function with service_role privileges.
create or replace function public.kp_tree_push_notification(
  p_nick text, p_id text, p_record jsonb
) returns boolean language plpgsql security definer set search_path = '' as $$
declare whole jsonb; profile jsonb; notifications jsonb; rev bigint;
begin
  if length(p_nick)>120 or length(p_id)>100 or length(p_id)<5 then
    raise exception 'Invalid notification key';
  end if;
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots
    where branch='users' for update;
  profile:=whole->p_nick;
  if profile is null then return false; end if;
  notifications:=coalesce(profile->'notifications','{}'::jsonb);
  notifications:=jsonb_set(notifications,array[p_id],p_record,true);
  whole:=jsonb_set(whole,array[p_nick],jsonb_set(profile,'{notifications}',notifications,true));
  update public.kp_tree_roots set document=whole, revision=rev+1, updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return true;
end; $$;
revoke all on function public.kp_tree_push_notification(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.kp_tree_push_notification(text,text,jsonb) to service_role;

create table if not exists public.kp_signup_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  attempted_at timestamptz not null default now()
);
create index if not exists kp_signup_attempts_ip_time on public.kp_signup_attempts(ip_hash,attempted_at);
alter table public.kp_signup_attempts enable row level security;
revoke all on public.kp_signup_attempts from anon,authenticated;

create or replace function public.kp_tree_bootstrap_user(p_nick text,p_profile jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare whole jsonb; rev bigint; cleaned jsonb;
begin
  if p_nick is null or char_length(p_nick) not between 3 and 30
     or jsonb_typeof(p_profile) <> 'object' then raise exception 'Invalid profile'; end if;
  if not exists(select 1 from public.kp_profiles where nickname=p_nick) then
    raise exception 'Profile is missing';
  end if;
  cleaned:=p_profile - 'passwordHash' - 'passwordHashSalt' - 'isAdmin' - 'roles';
  cleaned:=cleaned || jsonb_build_object(
    'nick',p_nick,'balance',0,'taskBalance',0,'savingsBalance',0,
    'totalEarned',0,'accountVerified',false,'accountFrozen',false,
    'job','Житель','subscription','none'
  );
  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots where branch='users' for update;
  if whole ? p_nick then raise exception 'Nickname already has a legacy profile'; end if;
  update public.kp_tree_roots
    set document=jsonb_set(whole,array[p_nick],cleaned,true),revision=rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision) values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return true;
end; $$;
revoke all on function public.kp_tree_bootstrap_user(text,jsonb) from public,anon,authenticated;
grant execute on function public.kp_tree_bootstrap_user(text,jsonb) to service_role;

commit;
