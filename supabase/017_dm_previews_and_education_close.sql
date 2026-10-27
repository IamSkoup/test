-- Kapani 017. Additive and idempotent. Apply after 001-016 yourself.
-- No casino balance, main wallet, old ledger or chat history is migrated.

begin;

-- Recompute both contact-list previews from messages that still exist.
-- A deleted photo cannot remain the canonical "last message". Both
-- participants may request repair, nobody can inspect another DM pair.
create or replace function public.kp_dm_reindex_v13(p_peer text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 a text:=public.kp_v8_actor(); conv text; root jsonb; idx jsonb;
 last_message jsonb; ts bigint:=0; read_a bigint:=0; read_peer bigint:=0;
 mine jsonb; theirs jsonb; summary jsonb;
begin
 if a is null or p_peer is null or p_peer=a
    or not exists(select 1 from public.kp_profiles where nickname=p_peer)
 then raise exception 'DM participants required';end if;
 conv:=case when a collate "C" < p_peer collate "C"
   then a||'__dm__'||p_peer else p_peer||'__dm__'||a end;
 insert into public.kp_tree_roots(branch) values('dms'),('dmIndex') on conflict do nothing;
 select document into root from public.kp_tree_roots where branch='dms' for update;
 select e.value into last_message
   from jsonb_each(case when jsonb_typeof(root->conv->'messages')='object'
     then root->conv->'messages' else '{}'::jsonb end) as e
   where jsonb_typeof(e.value)='object'
   order by case when coalesce(e.value->>'createdAt','')~'^[0-9]{1,16}$'
     then (e.value->>'createdAt')::bigint else 0 end desc, e.key desc limit 1;
 if last_message is not null then
   ts:=case when coalesce(last_message->>'createdAt','')~'^[0-9]{1,16}$'
     then (last_message->>'createdAt')::bigint else 0 end;
 end if;
 read_a:=coalesce((root->conv->'lastRead'->>a)::bigint,0);
 read_peer:=coalesce((root->conv->'lastRead'->>p_peer)::bigint,0);
 select document into idx from public.kp_tree_roots where branch='dmIndex' for update;
 mine:=coalesce(idx->a->p_peer,'{}'::jsonb);
 theirs:=coalesce(idx->p_peer->a,'{}'::jsonb);
 summary:=jsonb_build_object('lastTs',ts,'latest',last_message);
 mine:=mine||summary||jsonb_build_object('unread',
   last_message is not null and last_message->>'nick'<>a and ts>read_a);
 theirs:=theirs||summary||jsonb_build_object('unread',
   last_message is not null and last_message->>'nick'<>p_peer and ts>read_peer);
 idx:=public.kp_tree_set_deep(idx,array[a,p_peer],mine);
 idx:=public.kp_tree_set_deep(idx,array[p_peer,a],theirs);
 perform public.kp_v8_put('dmIndex',idx);
 return jsonb_build_object('lastTs',ts,'latest',last_message);
end; $$;
revoke all on function public.kp_dm_reindex_v13(text) from public,anon;
grant execute on function public.kp_dm_reindex_v13(text) to authenticated;

-- Delete and reindex in the same database transaction. If either step fails,
-- both roll back: no stale preview and no partially applied deletion.
create or replace function public.kp_dm_delete_v13(p_peer text,p_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform public.kp_message_v8('delete','dm',p_peer,p_id,'{}'::jsonb);
 return public.kp_dm_reindex_v13(p_peer);
end; $$;
revoke all on function public.kp_dm_delete_v13(text,text) from public,anon;
grant execute on function public.kp_dm_delete_v13(text,text) to authenticated;

-- Mayor-only closure. Preserve the paid education and request history.
-- A closure does not refund or charge money and does not permit repurchase.
create or replace function public.kp_education_close_v13(p_nick text,p_request_id text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 a text:=public.kp_v8_actor(); users_doc jsonb; requests_doc jsonb;
 purchase jsonb; request_doc jsonb; request_id text; at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 if a is distinct from 'Кайон' then raise exception 'Mayor access required';end if;
 if coalesce(p_nick,'')='' then raise exception 'Resident required';end if;
 select document into users_doc from public.kp_tree_roots where branch='users' for update;
 if users_doc->p_nick is null then raise exception 'Resident not found';end if;
 purchase:=users_doc->p_nick->'kEducationPurchase';
 if purchase is null or jsonb_typeof(purchase)<>'object' then raise exception 'Education request missing';end if;
 request_id:=coalesce(purchase->>'id','');
 if p_request_id<>'' and request_id is distinct from p_request_id then
   raise exception 'Education request changed; refresh the queue';end if;
 if purchase->>'status'='approved' then return purchase;end if;
 if purchase->>'status' not in ('pending','submitted','paid') then
   raise exception 'Only open education requests can be closed';end if;
 purchase:=purchase||jsonb_build_object('status','approved','closedAt',at_ms,'closedBy',a);
 users_doc:=public.kp_tree_set_deep(users_doc,array[p_nick,'kEducationPurchase'],purchase);
 perform public.kp_v8_put('users',users_doc);
 if request_id<>'' then
   insert into public.kp_tree_roots(branch) values('civicRequests') on conflict do nothing;
   select document into requests_doc from public.kp_tree_roots where branch='civicRequests' for update;
   request_doc:=requests_doc->request_id;
   if request_doc is not null and request_doc->>'kind'='education'
      and request_doc->>'from'=p_nick and request_doc->>'status'='pending' then
     request_doc:=request_doc||jsonb_build_object('status','approved',
       'reviewedAt',at_ms,'closedAt',at_ms,'closedBy',a);
     requests_doc:=public.kp_tree_set_deep(requests_doc,array[request_id],request_doc);
     perform public.kp_v8_put('civicRequests',requests_doc);
   end if;
 end if;
 perform public.kp_v8_notify(p_nick,'Заявка на К-образование закрыта мэрией',
   'system','education_close_'||coalesce(nullif(request_id,''),p_nick));
 return purchase;
end; $$;
revoke all on function public.kp_education_close_v13(text,text) from public,anon;
grant execute on function public.kp_education_close_v13(text,text) to authenticated;

commit;
