-- Apply after 001–007. Additive: no accounts, balances or requests are deleted.
begin;
create or replace function public.kp_v8_actor() returns text language sql stable security definer set search_path='' as $$
 select nickname from public.kp_profiles where user_id=auth.uid();
$$;
create or replace function public.kp_v8_role(n text, r text) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select document->n->>'job'=r or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(document->n->'employments')='array' then document->n->'employments' else '[]'::jsonb end) e where e->>'type'='municipal' and e->>'role'=r) from public.kp_tree_roots where branch='users'),false);
$$;
create or replace function public.kp_v8_put(b text,d jsonb) returns void language plpgsql security definer set search_path='' as $$
declare v bigint;
begin
 insert into public.kp_tree_roots(branch,document,revision) values(b,d,1)
 on conflict(branch) do update set document=excluded.document,revision=kp_tree_roots.revision+1,updated_at=now() returning revision into v;
 insert into public.kp_tree_revisions(branch,revision) values(b,v) on conflict(branch) do update set revision=excluded.revision;
end; $$;
create or replace function public.kp_v8_public_profile(d jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(coalesce(d,'{}'::jsonb)) where key=any(array['nick','displayName','avatar','avatarUrl','photoURL','bio','about','description','profileDescription','job','employments','displayJob','vehicle','lastSeen','subscription','subscriptionExpiry','avatarFrame','profileBg','profileBgEffect','profileCustomBg','chatBubbleStyle','nicknameColor','nicknameEmoji','accountVerified']);
$$;
-- Keep the old implementation private so callers cannot bypass the new checks.
do $$ begin
 if to_regprocedure('public.kp_tree_access_v7(text,text,jsonb,bigint)') is null then
 alter function public.kp_tree_access(text,text,jsonb,bigint) rename to kp_tree_access_v7;
 end if;
end $$;
revoke all on function public.kp_tree_access_v7(text,text,jsonb,bigint) from public,anon,authenticated;
create or replace function public.kp_tree_access(p_operation text,p_path text default '',p_payload jsonb default null,p_expected_revision bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); parts text[]:=string_to_array(trim(both '/' from p_path),'/'); b text; d jsonb; v bigint; x jsonb; staff boolean;
begin
 b:=parts[1]; if b='apps' then b:='jobApps'; parts[1]:=b; p_path:=array_to_string(parts,'/'); end if;
 if p_operation<>'read' then
   if b='chat' or (b='dms' and parts[3]='messages') then raise exception 'Use protected message service';end if;
   return public.kp_tree_access_v7(p_operation,p_path,p_payload,p_expected_revision);
 end if;
 if a is null then return jsonb_build_object('value',null,'revision',0); end if;
 staff:=a='Кайон' or public.kp_v8_role(a,'КСБ') or public.kp_v8_role(a,'Полицейский');
 select document,revision into d,v from public.kp_tree_roots where branch=b;
 d:=coalesce(d,'{}');
 if b='users' then
   if cardinality(parts)=1 then
     select coalesce(jsonb_object_agg(key,case when key=a or a='Кайон' then value-'passwordHash'-'passwordHashSalt' else public.kp_v8_public_profile(value) end),'{}') into x from jsonb_each(d);
   elsif parts[2]=a or a='Кайон' then x:=d #> parts[2:cardinality(parts)];
   else
     x:=public.kp_v8_public_profile(d->parts[2]);
     if cardinality(parts)>2 then x:=x #> parts[3:cardinality(parts)]; end if;
   end if;
   if jsonb_typeof(x)='object' then x:=x-'passwordHash'-'passwordHashSalt'; end if;
 elsif b='walls' then
   if cardinality(parts)<2 then raise exception 'Choose a profile'; end if;
   x:=d #> parts[2:cardinality(parts)];
 elsif b in ('passports','licenses') then
   if cardinality(parts)<2 or (parts[2]<>a and not staff) then raise exception 'Private profile data'; end if;
   x:=d #> parts[2:cardinality(parts)];
 elsif b in ('jobApps','businessApps','bizDeleteRequests','janitorSubmissions','atmRequests','deputyProposals','policeRequests','civicRequests') then
   if a<>'Кайон' then select coalesce(jsonb_object_agg(key,value),'{}') into d from jsonb_each(d) where coalesce(value->>'from',value->>'owner',value->>'worker',value->>'nick',value->>'author',value->>'officer')=a; end if;
   x:=case when cardinality(parts)=1 then d else d #> parts[2:cardinality(parts)] end;
 elsif b in ('orders','deliveryCustomOrders') then
   if a<>'Кайон' then select coalesce(jsonb_object_agg(key,value),'{}') into d from jsonb_each(d)
     where value->>'client'=a or value->>'worker'=a or (value->>'status' in ('pending','waiting') and public.kp_v8_role(a,case when b='orders' then 'Водитель' else 'Доставщик' end));end if;
   x:=case when cardinality(parts)=1 then d else d #> parts[2:cardinality(parts)] end;
 elsif b in ('bizOrders','bizJobApps','bizComplaints') then
   select coalesce(jsonb_object_agg(biz.key,coalesce((select jsonb_object_agg(e.key,e.value) from jsonb_each(biz.value)e
     where a='Кайон' or (select document->biz.key->>'owner' from public.kp_tree_roots where branch='businesses')=a
       or coalesce(e.value->>'client',e.value->>'from',e.value->>'applicant')=a),'{}')),'{}') into d from jsonb_each(d)biz;
   x:=case when cardinality(parts)=1 then d else d #> parts[2:cardinality(parts)] end;
 elsif b='hospital' then
   x:=public.kp_hospital_view();
   if cardinality(parts)>1 then x:=x #> parts[2:cardinality(parts)]; end if;
 else return public.kp_tree_access_v7(p_operation,p_path,p_payload,p_expected_revision);
 end if;
 return jsonb_build_object('value',x,'revision',coalesce(v,0));
end; $$;
revoke all on function public.kp_tree_access(text,text,jsonb,bigint) from public;
grant execute on function public.kp_tree_access(text,text,jsonb,bigint) to anon,authenticated;
create or replace function public.kp_license_status(p_target text) returns jsonb language plpgsql security definer set search_path='' as $$
declare d jsonb;
begin
 d:=public.kp_tree_access('read','licenses/'||p_target);
 return coalesce((select document->p_target->'licenses' from public.kp_tree_roots where branch='users'),'{}')||coalesce(d->'value','{}');
end; $$;
-- Merge the old inbox once; new records take precedence.
insert into public.kp_tree_roots(branch,document) select 'jobApps',document from public.kp_tree_roots where branch='apps'
 on conflict(branch) do update set document=excluded.document||kp_tree_roots.document;
-- Publication metadata is committed together with the existing marketplace RPC.
do $$ begin
 if to_regprocedure('public.kp_market_action_v7(text,text,jsonb)') is null then
 alter function public.kp_market_action(text,text,jsonb) rename to kp_market_action_v7;
 end if;
end $$;
revoke all on function public.kp_market_action_v7(text,text,jsonb) from public,anon,authenticated;
create or replace function public.kp_market_action(p_action text,p_listing_id text,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; d jsonb; photos jsonb; pic jsonb;
begin
 if p_action='create' then
   photos:=coalesce(p_payload->'photos','[]');
   if jsonb_typeof(photos)<>'array' or jsonb_array_length(photos)>8 then raise exception 'Maximum 8 photos'; end if;
   for pic in select value from jsonb_array_elements(photos) loop
     if jsonb_typeof(pic)<>'string' or length(pic#>>'{}')>2500000 or (pic#>>'{}') !~ '^(https://|data:image/(jpeg|png|webp);base64,)' then raise exception 'Invalid image'; end if;
   end loop;
   if (p_payload ? 'sellerLat')<>(p_payload ? 'sellerLng') then raise exception 'Select both coordinates'; end if;
   if p_payload ? 'sellerLat' and not public.kp_v8_point(p_payload->>'sellerLat',p_payload->>'sellerLng') then raise exception 'Invalid map point'; end if;
 end if;
 result:=public.kp_market_action_v7(p_action,p_listing_id,p_payload);
 if p_action='create' then
   select document into d from public.kp_tree_roots where branch='marketplace' for update;
   d:=jsonb_set(d,array[p_listing_id],(d->p_listing_id)||jsonb_build_object('photos',photos,'createdAt',(extract(epoch from now())*1000)::bigint,'condition',left(coalesce(p_payload->>'condition',''),80),'address',left(coalesce(p_payload->>'address',''),200))||case when p_payload ? 'sellerLat' then jsonb_build_object('sellerLat',p_payload->'sellerLat','sellerLng',p_payload->'sellerLng') else '{}'::jsonb end);
   perform public.kp_v8_put('marketplace',d);
 end if;
 return result;
end; $$;
create or replace function public.kp_v8_point(lat text,lng text) returns boolean language plpgsql immutable set search_path='' as $$
begin
 if lat is null or lng is null or lat='' or lng='' then return false; end if;
 return lat::numeric between -90 and 90 and lng::numeric between -180 and 180;
exception when others then return false;
end; $$;
revoke all on function public.kp_v8_actor(),public.kp_v8_role(text,text),public.kp_v8_put(text,jsonb),public.kp_v8_public_profile(jsonb),public.kp_v8_point(text,text) from public,anon,authenticated;
revoke all on function public.kp_market_action(text,text,jsonb) from public,anon;
grant execute on function public.kp_market_action(text,text,jsonb) to authenticated;
commit;
