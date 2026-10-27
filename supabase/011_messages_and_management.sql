begin;
create or replace function public.kp_message_v8(p_action text,p_kind text,p_peer text default null,p_id text default null,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); b text; conv text; path text[]; root jsonb; msg jsonb; users jsonb; attachment jsonb; reply jsonb; emoji text; target jsonb; idx jsonb; at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 if a is null or p_kind not in ('chat','dm') or coalesce(p_id,'')!~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'Invalid message request'; end if;
 if p_kind='dm' then
   if p_peer is null or not exists(select 1 from public.kp_profiles where nickname=p_peer) then raise exception 'Recipient missing'; end if;
   conv:=case when a collate "C" < p_peer collate "C" then a||'__dm__'||p_peer else p_peer||'__dm__'||a end;
   b:='dms';path:=array[conv,'messages',p_id];
 else b:='chat';path:=array[p_id];end if;
 select document into users from public.kp_tree_roots where branch='users';
 insert into public.kp_tree_roots(branch) values(b) on conflict do nothing;
 select document into root from public.kp_tree_roots where branch=b for update;
 msg:=root #> path;
 if p_action='send' then
   if msg is not null then
     if msg->>'nick'<>a then raise exception 'Message identifier collision'; end if;
     return msg;
   end if;
   if length(coalesce(p_data->>'text',''))>4000 or jsonb_typeof(coalesce(p_data->'attachments','[]'))<>'array' or jsonb_array_length(coalesce(p_data->'attachments','[]'))>6 then raise exception 'Message limit exceeded'; end if;
   for attachment in select value from jsonb_array_elements(coalesce(p_data->'attachments','[]')) loop
     if attachment->>'type' is null or attachment->>'type' not in ('image','video','voice','video_circle','sticker') or coalesce(attachment->>'url','')!~ '^https://' or length(attachment->>'url')>2000 then raise exception 'Invalid attachment'; end if;
   end loop;
   msg:=jsonb_build_object('nick',a,'avatar',users->a->>'avatar','text',left(coalesce(p_data->>'text',''),4000),'attachments',coalesce(p_data->'attachments','[]'),'createdAt',at_ms,'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI'));
   if p_data ? 'replyId' then
     reply:=root #> (case when p_kind='chat' then array[p_data->>'replyId'] else array[conv,'messages',p_data->>'replyId'] end);
     if reply is not null then msg:=msg||jsonb_build_object('reply',jsonb_build_object('id',p_data->>'replyId','nick',reply->>'nick','text',left(coalesce(reply->>'text','Вложение'),180)));end if;
   end if;
   if p_data ? 'forward' then
     target:=public.kp_tree_access('read',p_data->'forward'->>'path');reply:=target->'value';
     if (p_data->'forward'->>'path') !~ '^(chat/[^/]+|dms/[^/]+/messages/[^/]+)$' or reply is null or reply->>'nick' is null then raise exception 'Forwarded message unavailable'; end if;
     msg:=msg||jsonb_build_object('text',reply->>'text','attachments',coalesce(reply->'attachments',case when reply->>'mediaData' is not null then jsonb_build_array(jsonb_build_object('url',reply->>'mediaData','type',reply->>'msgType')) else '[]'::jsonb end),'forwardedFrom',reply->>'nick');
   end if;
   if coalesce(msg->>'text','')='' and jsonb_array_length(msg->'attachments')=0 then raise exception 'Empty message'; end if;
 elsif p_action='reaction' then
   if msg is null then raise exception 'Message missing'; end if;
   emoji:=p_data->>'emoji';if emoji not in ('👍','❤️','😂','🔥','😮','😢') then raise exception 'Unsupported reaction'; end if;
   target:=coalesce(msg->'reactions','{}');
   if target->>a=emoji then target:=target-a;else target:=jsonb_set(target,array[a],to_jsonb(emoji),true);end if;
   msg:=msg||jsonb_build_object('reactions',target);
 elsif p_action='edit' then
   if msg is null or msg->>'nick'<>a then raise exception 'Only author can edit'; end if;
   if length(trim(coalesce(p_data->>'text',''))) not between 1 and 4000 then raise exception 'Invalid message text';end if;
   msg:=msg||jsonb_build_object('text',trim(p_data->>'text'),'caption',trim(p_data->>'text'),'edited',true);
 elsif p_action='delete' then
   if msg is null then return jsonb_build_object('ok',true);end if;
   if msg->>'nick'<>a then raise exception 'Only author can delete'; end if;
   root:=root #- path;perform public.kp_v8_put(b,root);return jsonb_build_object('ok',true);
 else raise exception 'Unknown message action';end if;
 root:=public.kp_tree_set_deep(root,path,msg);perform public.kp_v8_put(b,root);
 if p_kind='dm' and p_action='send' then
   insert into public.kp_tree_roots(branch) values('dmIndex') on conflict do nothing;
   select document into idx from public.kp_tree_roots where branch='dmIndex' for update;
   target:=jsonb_build_object('lastTs',at_ms,'latest',msg);
   idx:=public.kp_tree_set_deep(idx,array[a,p_peer],target||'{"unread":false}');
   idx:=public.kp_tree_set_deep(idx,array[p_peer,a],target||'{"unread":true}');
   perform public.kp_v8_put('dmIndex',idx);
 end if;
 return msg;
end; $$;

-- Restricted editors for existing business, racing and hospital interfaces.
create or replace function public.kp_content_v8(p_operation text,p_path text,p_payload jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); p text[]:=string_to_array(p_path,'/');b text;d jsonb;old jsonb;v jsonb;k text;u jsonb;entity jsonb;product record;max_price bigint;max_count integer;
begin
 if a is null then raise exception 'Authentication required';end if;
 b:=p[1];if p_operation not in ('set','update','remove') then raise exception 'Invalid operation';end if;
 select document->a into u from public.kp_tree_roots where branch='users' for update;
 insert into public.kp_tree_roots(branch) values(b) on conflict do nothing;
 select document into d from public.kp_tree_roots where branch=b for update;
 old:=d #> p[2:cardinality(p)];
 if b in ('races','raceDayGroups','rentBuildings') then
   if a<>'Кайон' or cardinality(p)<2 then raise exception 'Mayor access required';end if;
   if b='rentBuildings' and cardinality(p)<>2 then raise exception 'Choose a building';end if;
   if b='rentBuildings' and p_operation='update' then
     for k in select jsonb_object_keys(p_payload) loop
       if k not in ('name','weekPrice','photo') then raise exception 'Rental status is managed by the server';end if;
     end loop;
   end if;
 elsif b='businesses' then
   if d->p[2]->>'owner' is distinct from a or cardinality(p)<2 then raise exception 'Business owner required';end if;
   if cardinality(p)=2 then
     if p_operation<>'update' then raise exception 'Only business details may be updated';end if;
     for k in select jsonb_object_keys(p_payload) loop
       if k ~ '^(products|roles)/[A-Za-z0-9_-]+$' then
         v:=p_payload->k;
         if k like 'products/%' and v<>'null'::jsonb and (v->>'price' is null or (v->>'price')::numeric not between 1 and 100000 or length(coalesce(v->>'name','')) not between 1 and 120) then raise exception 'Invalid product';end if;
         continue;
       end if;
       if k not in ('name','desc','address','lat','lng','category','services','icon','banner','delivery','bgEffect','description') then raise exception 'Protected business field: %',k;end if;
       if k='bgEffect' and p_payload->k not in ('null'::jsonb,'""'::jsonb) then raise exception 'Purchase business decoration via finance service';end if;
     end loop;
   elsif p[3] not in ('products','roles') or cardinality(p)<>4 then raise exception 'Protected business field';end if;
   if p[3]='roles' and p_operation='remove' and exists(
      select 1 from jsonb_each(coalesce(d->p[2]->'employees','{}'))e where e.value->>'roleId'=p[4]
   ) then raise exception 'Dismiss or move employees before deleting their role';end if;
   if p[3]='products' and p_operation<>'remove' then
     v:=coalesce(old,'{}')||p_payload;
     if v->>'price' is null or (v->>'price')::numeric not between 1 and 100000 or length(coalesce(v->>'name','')) not between 1 and 120 then raise exception 'Invalid product';end if;
   end if;
 elsif b='hospital' then
   if not public.kp_v8_role(a,'Врач') or p[2] not in ('services','photos','assistantSalary') then raise exception 'Doctor access required';end if;
   if p[2]='services' and p_operation<>'remove' then
     v:=coalesce(old,'{}')||p_payload;
     if v->>'price' is null or (v->>'price')::numeric not between 0 and 10000 or length(coalesce(v->>'name','')) not between 1 and 120 then raise exception 'Invalid service';end if;
   end if;
 elsif b in ('janitorSubmissions','deputyProposals','atmRequests','bizDeleteRequests') then
   if cardinality(p)<>2 or p_operation<>'set' or old is not null then raise exception 'Use review service for existing requests';end if;
   if b='janitorSubmissions' and not public.kp_v8_role(a,'Уборщик') then raise exception 'Janitor access required';end if;
   if b='deputyProposals' and not public.kp_v8_role(a,'Депутат') then raise exception 'Deputy access required';end if;
   if b='bizDeleteRequests' and (select document->(p_payload->>'bizId')->>'owner' from public.kp_tree_roots where branch='businesses') is distinct from a then raise exception 'Business owner required';end if;
   if b='janitorSubmissions' and exists(select 1 from jsonb_each(d)e where e.value->>'worker'=a and e.value->>'date'=to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD') and e.value->>'status' in ('pending','approved')) then raise exception 'Today already submitted';end if;
   p_payload:=p_payload||jsonb_build_object('date',to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD'),'id',p[2],'from',a,'owner',a,'worker',a,'nick',a,'author',a,'status','pending','createdAt',(extract(epoch from now())*1000)::bigint);
 elsif b='bizComplaints' then
   if cardinality(p)<>3 then raise exception 'Choose one message';end if;
   if p_operation='set' and old is null then
     if length(trim(coalesce(p_payload->>'text',''))) not between 5 and 2000 then raise exception 'Message length 5 to 2000';end if;
     p_payload:=p_payload||jsonb_build_object('id',p[3],'from',a,'createdAt',(extract(epoch from now())*1000)::bigint);
   elsif p_operation='remove' and (old->>'from'=a or (select document->p[2]->>'owner' from public.kp_tree_roots where branch='businesses')=a) then null;
   else raise exception 'Message author or business owner required';end if;
 else raise exception 'Unsupported content branch';end if;
 if octet_length(coalesce(p_payload,'null')::text)>3000000 then raise exception 'Content too large';end if;
 if p_operation='remove' then d:=d #- p[2:cardinality(p)];v:=null;
 else
   v:=coalesce(old,'{}');
   if p_operation='update' then
     for k in select jsonb_object_keys(p_payload) loop
       if p_payload->k='null'::jsonb then v:=v #- string_to_array(k,'/');else v:=public.kp_tree_set_deep(v,string_to_array(k,'/'),p_payload->k);end if;
     end loop;
   else v:=p_payload;end if;
   d:=public.kp_tree_set_deep(d,p[2:cardinality(p)],v);
 end if;
 if b='rentBuildings' and p_operation<>'remove' then
   entity:=d->p[2];
   if length(trim(coalesce(entity->>'name',''))) not between 2 and 80 or
      coalesce(entity->>'weekPrice','') !~ '^[0-9]{1,6}$' or
      (entity->>'weekPrice')::bigint not between 1 and 100000 or
      length(coalesce(entity->>'photo',''))>2500000 then raise exception 'Invalid rental advertisement';end if;
 elsif b='businesses' and p_operation<>'remove' then
   entity:=d->p[2];
   max_count:=3+least(100,coalesce((entity->'limitBonus'->>'products')::integer,(entity->'limitBonus'->>'product')::integer,0));
   max_price:=1000+500*coalesce((entity->'limitBonus'->>'priceCap')::integer,0);
   if (select count(*) from jsonb_object_keys(coalesce(entity->'products','{}'))) >max_count then raise exception 'Product limit exceeded';end if;
   for product in select key,value from jsonb_each(coalesce(entity->'products','{}')) loop
     if length(trim(coalesce(product.value->>'name',''))) not between 1 and 120 or
       coalesce(product.value->>'price','') !~ '^[0-9]{1,8}$' or
       (product.value->>'price')::bigint not between 1 and max_price then raise exception 'Product price or name outside permitted limits';end if;
   end loop;
   if not public.kp_v8_point(entity->>'lat',entity->>'lng') then raise exception 'Business needs a map location';end if;
   if length(coalesce(entity->>'name','')) not between 2 and 80 then raise exception 'Business name length exceeded';end if;
 end if;
 perform public.kp_v8_put(b,d);return jsonb_build_object('value',v,'committed',true);
end; $$;
create or replace function public.kp_business_application_v8(p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();apps jsonb;users jsonb;businesses jsonb;o jsonb;fee bigint:=2500;owner text;count_owned integer;ids jsonb;
begin
 if a is null or coalesce(p_id,'')!~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'Invalid application';end if;
 insert into public.kp_tree_roots(branch) values('users'),('businessApps'),('businesses') on conflict do nothing;
 select document into users from public.kp_tree_roots where branch='users' for update;
 select document into apps from public.kp_tree_roots where branch='businessApps' for update;
 select document into businesses from public.kp_tree_roots where branch='businesses' for update;
 o:=apps->p_id;
 if p_action='submit' then
   if o is not null then if o->>'owner'=a then return o;else raise exception 'Duplicate identifier';end if;end if;
   if coalesce(users->a->>'accountVerified','false')<>'true' or users->a->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if exists(select 1 from jsonb_each(apps)e where e.value->>'owner'=a and e.value->>'status'='pending') then raise exception 'An application is already pending';end if;
   select count(*) into count_owned from jsonb_each(businesses)e where e.value->>'owner'=a and e.value->>'status'='active';
   if count_owned>=3 then raise exception 'Maximum three active businesses';end if;
   if length(trim(coalesce(p_data->>'name',''))) not between 2 and 80 or length(trim(coalesce(p_data->>'desc',''))) not between 5 and 2000 or not public.kp_v8_point(p_data->>'lat',p_data->>'lng') then raise exception 'Complete the business application and map point';end if;
   perform public.kp_v8_money(a,-fee,(md5(p_id||':business-fee'))::uuid,'business_application');
   o:=jsonb_build_object('id',p_id,'owner',a,'name',trim(p_data->>'name'),'desc',p_data->>'desc','address',left(p_data->>'address',200),'lat',p_data->'lat','lng',p_data->'lng','category',left(p_data->>'category',80),'services',left(p_data->>'services',1000),'status','pending','feePaid',fee,'createdAt',(extract(epoch from now())*1000)::bigint);
 else
   if a<>'Кайон' or p_action not in ('approve','reject') or o is null then raise exception 'Mayor review required';end if;
   if o->>'status'<>'pending' then return o;end if;
   owner:=o->>'owner';
   if p_action='approve' then
     businesses:=jsonb_set(businesses,array[p_id],o||jsonb_build_object('status','active','balance',0,'delivery',false,'products','{}'::jsonb,'roles','{}'::jsonb,'employees','{}'::jsonb),true);
     perform public.kp_v8_put('businesses',businesses);
     ids:=coalesce(users->owner->'businessIds','[]');if not(ids ? p_id) then ids:=ids||to_jsonb(p_id);end if;
     select document into users from public.kp_tree_roots where branch='users';
     users:=jsonb_set(users,array[owner],(users->owner)||jsonb_build_object('businessIds',ids,'businessId',ids->>0));perform public.kp_v8_put('users',users);
   else perform public.kp_v8_money(owner,coalesce((o->>'feePaid')::bigint,0),(md5(p_id||':business-refund'))::uuid,'business_refund');end if;
   o:=o||jsonb_build_object('status',case when p_action='approve' then 'approved' else 'rejected' end);
 end if;
 apps:=jsonb_set(apps,array[p_id],o,true);perform public.kp_v8_put('businessApps',apps);return o;
end; $$;
revoke all on function public.kp_message_v8(text,text,text,text,jsonb),public.kp_content_v8(text,text,jsonb),public.kp_business_application_v8(text,text,jsonb) from public,anon;
grant execute on function public.kp_message_v8(text,text,text,text,jsonb),public.kp_content_v8(text,text,jsonb),public.kp_business_application_v8(text,text,jsonb) to authenticated;
commit;
