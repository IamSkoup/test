-- Kapani 016. Apply manually after 001–015. Does not touch balances or users.
-- Keep the secure profile allowlist, but honour the Plus avatar frames that
-- the site already offers. All checks run against the server-side tier.

create or replace function public.kp_profile_patch(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  nick text; whole jsonb; profile jsonb; rev bigint; k text; v jsonb;
  active_subscription boolean; prime_subscription boolean; val text;
  subscription_tier integer := 0;
  plus_frames constant text[] := array['gold','pulse','neon','ice','forest_moss','nature_meadow'];
  ultra_frames constant text[] := array['rainbow','glow','fire','crystal','rose',
    'plasma','thunder','hologram','dragon','forest_dusk','nature_aurora','wild_ember'];
  prime_frames constant text[] := array['prime','wild_storm'];
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
  if active_subscription then
    subscription_tier := case profile->>'subscription' when 'plus' then 1
      when 'ultra' then 2 when 'prime' then 3 else 0 end;
  end if;
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
      if length(val)>64 or (val<>'' and not (
         (subscription_tier>=1 and val=any(plus_frames)) or
         (subscription_tier>=2 and val=any(ultra_frames)) or
         (subscription_tier>=3 and val=any(prime_frames))
      )) then raise exception 'This frame requires a matching active subscription'; end if;
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
