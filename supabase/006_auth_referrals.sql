-- Apply after 001-005. Keep signup's optional inviter without accepting
-- balance, job, or other privileged profile fields from the browser.
begin;

create or replace function public.kp_tree_bootstrap_user(p_nick text,p_profile jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  whole jsonb;
  rev bigint;
  cleaned jsonb;
  inviter text;
  inviter_name text;
  created_ms bigint;
begin
  if p_nick is null or char_length(p_nick) not between 3 and 30
     or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'Invalid profile';
  end if;
  if not exists(select 1 from public.kp_profiles where nickname=p_nick) then
    raise exception 'Profile is missing';
  end if;

  created_ms:=(extract(epoch from clock_timestamp()) * 1000)::bigint;
  cleaned:=jsonb_build_object(
    'nick',p_nick,
    'displayName',left(coalesce(p_profile->>'displayName',p_nick),60),
    'balance',0,'taskBalance',0,'savingsBalance',0,'totalEarned',0,
    'accountVerified',false,'accountFrozen',false,
    'job','Житель','subscription','none',
    'createdAt',created_ms
  );

  insert into public.kp_tree_roots(branch) values('users') on conflict do nothing;
  select document,revision into whole,rev from public.kp_tree_roots
    where branch='users' for update;
  if whole ? p_nick then raise exception 'Nickname already has a legacy profile'; end if;

  inviter:=nullif(trim(p_profile->>'invitedBy'),'');
  if inviter is not null then
    if inviter=p_nick or not (whole ? inviter)
       or not exists(select 1 from public.kp_profiles where nickname=inviter) then
      raise exception 'Invalid inviter nickname';
    end if;
    inviter_name:=left(coalesce(nullif(whole->inviter->>'displayName',''),inviter),60);
    cleaned:=cleaned || jsonb_build_object(
      'invitedBy',inviter,
      'invitedByName',inviter_name,
      'referralCreatedAt',created_ms,
      'referralWeekKey',to_char(date_trunc('week',clock_timestamp()),'YYYY-MM-DD')
    );
  end if;

  update public.kp_tree_roots
    set document=jsonb_set(whole,array[p_nick],cleaned,true),
        revision=rev+1,updated_at=now()
    where branch='users';
  insert into public.kp_tree_revisions(branch,revision)
    values('users',rev+1)
    on conflict(branch) do update set revision=excluded.revision;
  return true;
end; $$;

revoke all on function public.kp_tree_bootstrap_user(text,jsonb) from public,anon,authenticated;
grant execute on function public.kp_tree_bootstrap_user(text,jsonb) to service_role;

commit;
