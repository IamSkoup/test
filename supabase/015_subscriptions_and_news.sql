-- Kapani v10: subscriptions and news must never mutate protected roots from JS.
-- Requires 001-014. Safe to run again; live balances are not imported.
begin;

create table if not exists public.kp_v10_subscription_ops(
 id uuid primary key,actor text not null,action text not null,
 plan text,recipient text,result jsonb not null,created_at timestamptz not null default now()
);
alter table public.kp_v10_subscription_ops enable row level security;
revoke all on public.kp_v10_subscription_ops from public,anon,authenticated;

create or replace function public.kp_subscription_v10(
 p_action text,p_id uuid,p_plan text default null,p_recipient text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();users jsonb;payer jsonb;target jsonb;
 target_nick text;old public.kp_v10_subscription_ops%rowtype;
 price bigint:=0;wallet_after bigint;expiry timestamptz;existing_expiry timestamptz;
 old_rank integer;new_rank integer;plan_start timestamptz:=now();
 result jsonb;treasury jsonb;now_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 if a is null or p_id is null or p_action not in ('buy','gift','cancel') then raise exception 'Invalid subscription request';end if;
 select document into users from public.kp_tree_roots where branch='users' for update;
 payer:=users->a;
 if payer is null or payer->>'accountFrozen'='true' or coalesce(payer->>'accountVerified','false')<>'true' then
   raise exception 'Verified active account required';
 end if;
 select * into old from public.kp_v10_subscription_ops where id=p_id;
 if found then
   if old.actor<>a or old.action<>p_action or old.plan is distinct from p_plan
     or old.recipient is distinct from p_recipient then raise exception 'Subscription retry mismatch';end if;
   return old.result;
 end if;
 if p_action='cancel' then
   users:=jsonb_set(users,array[a,'subscriptionAutoRenew'],'false'::jsonb,true);
   perform public.kp_v8_put('users',users);
   result:=jsonb_build_object('success',true,'subscription',payer->>'subscription',
     'expiresAt',payer->>'subscriptionExpiry','cancelledRenewal',true);
 else
   price:=case p_plan when 'plus' then 299 when 'ultra' then 899 when 'prime' then 1499 else null end;
   if price is null then raise exception 'Unknown subscription plan';end if;
   target_nick:=case when p_action='gift' then nullif(trim(coalesce(p_recipient,'')),'') else a end;
   if target_nick is null or (p_action='gift' and target_nick=a) then raise exception 'Choose another recipient';end if;
   target:=users->target_nick;
   if target is null or target->>'accountFrozen'='true' then raise exception 'Recipient unavailable';end if;
   existing_expiry:=case when coalesce(target->>'subscriptionExpiry','') ~ '^20[0-9][0-9]-'
     then (target->>'subscriptionExpiry')::timestamptz else null end;
   old_rank:=case when existing_expiry>now() then
     case target->>'subscription' when 'plus' then 1 when 'ultra' then 2 when 'prime' then 3 else 0 end
     else 0 end;
   new_rank:=case p_plan when 'plus' then 1 when 'ultra' then 2 else 3 end;
   if p_action='gift' and old_rank>new_rank then raise exception 'Recipient has a higher subscription';end if;
   -- A same-plan purchase extends; a different plan starts a fresh seven-day term.
   expiry:=case when old_rank=new_rank and target->>'subscription'=p_plan and existing_expiry>now()
     then existing_expiry+interval '7 days' else now()+interval '7 days' end;
   wallet_after:=public.kp_v8_money(a,-price,p_id,'subscription_'||p_action,
     jsonb_build_object('plan',p_plan,'recipient',target_nick));
   -- kp_v8_money has just updated users/<payer>/balance. Read that version.
   select document into users from public.kp_tree_roots where branch='users';
   target:=users->target_nick;
   if old_rank=new_rank and target->>'subscription'=p_plan and existing_expiry>now() then
     plan_start:=coalesce(nullif(target->>'subscriptionStart','')::timestamptz,now());
   end if;
   target:=target||jsonb_build_object('subscription',p_plan,'subscriptionExpiry',to_char(expiry at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     'subscriptionStart',to_char(plan_start at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     'subscriptionAutoRenew',false);
   perform public.kp_v8_put('users',jsonb_set(users,array[target_nick],target));
   insert into public.kp_tree_roots(branch) values('municipalTreasury') on conflict do nothing;
   select document into treasury from public.kp_tree_roots where branch='municipalTreasury' for update;
   treasury:=coalesce(treasury,'{}'::jsonb)||jsonb_build_object('balance',coalesce((treasury->>'balance')::bigint,0)+price);
   perform public.kp_v8_put('municipalTreasury',treasury);
   result:=jsonb_build_object('success',true,'subscription',p_plan,'recipient',target_nick,
     'price',price,'balance',wallet_after,'expiresAt',expiry,'transactionId',p_id);
   perform public.kp_v8_notify(target_nick,
     case when p_action='gift' then 'Подарена подписка '||p_plan||' от '||a else 'Подписка '||p_plan||' оплачена' end,
     'system','subscription_'||p_id::text);
 end if;
 insert into public.kp_v10_subscription_ops(id,actor,action,plan,recipient,result)
 values(p_id,a,p_action,p_plan,p_recipient,result);
 return result;
end; $$;

create or replace function public.kp_news_v10(
 p_action text,p_news_id text,p_message_id text default null,p_data jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();users jsonb;actor jsonb;news jsonb;discussions jsonb;
 item jsonb;message jsonb;now_ms bigint:=(extract(epoch from now())*1000)::bigint;
 scope text;news_id text;body text;image_url text;video_url text;op text;msg_type text;resident text;
begin
 if a is null or p_action not in ('publish','delete','comment_send','comment_edit','comment_delete','read') or
   coalesce(p_news_id,'') !~ '^[A-Za-z0-9_-]{8,100}$' then raise exception 'Invalid news request';end if;
 select document->a into actor from public.kp_tree_roots where branch='users';
 if actor is null or actor->>'accountFrozen'='true' then raise exception 'Account unavailable';end if;
 insert into public.kp_tree_roots(branch) values('news'),('newsDiscussions') on conflict do nothing;
 select document into news from public.kp_tree_roots where branch='news' for update;
 item:=news->p_news_id;
 if p_action='publish' then
   scope:=coalesce(p_data->>'scope','village');
   if scope not in ('village','lands') or
     not(a='Кайон' or (scope='village' and public.kp_v8_role(a,'Журналист'))) then
     raise exception 'News publisher role required';end if;
   if item is not null then
     if item->>'author'=a then return item;end if;
     raise exception 'News identifier already belongs to someone else';
   end if;
   if length(trim(coalesce(p_data->>'title',''))) not between 2 and 150 or
     length(trim(coalesce(p_data->>'content',''))) not between 2 and 10000 then
     raise exception 'News title or content length invalid';end if;
   if coalesce(p_data->>'category','general') not in
     ('general','event','alert','update','meteorology','announcement') then
     raise exception 'Unknown news category';end if;
   image_url:=coalesce(p_data->>'imageUrl','');
   video_url:=coalesce(p_data->>'videoUrl','');
   if length(image_url)>2500000 or (image_url<>'' and image_url !~ '^(https://|data:image/(png|jpeg|webp);base64,)') or
      length(video_url)>1500 or (video_url<>'' and video_url !~ '^https://') then
     raise exception 'Invalid news media URL';end if;
   item:=jsonb_build_object('id',p_news_id,'scope',scope,'title',left(trim(p_data->>'title'),150),
     'content',left(trim(p_data->>'content'),10000),'category',coalesce(p_data->>'category','general'),
     'imageUrl',nullif(image_url,''),'videoUrl',nullif(video_url,''),
     'author',a,'authorJob',coalesce(actor->>'job','Житель'),'createdAt',now_ms,
     'date',to_char(now() at time zone 'Europe/Moscow','DD.MM.YYYY'),
     'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI'));
   perform public.kp_v8_put('news',jsonb_set(coalesce(news,'{}'),array[p_news_id],item,true));
   -- In-app notifications are server-owned; do not fan out with client-side tree writes.
   select document into users from public.kp_tree_roots where branch='users' for update;
   for resident in select key from jsonb_each(coalesce(users,'{}'::jsonb)) loop
     if resident<>a then
       users:=public.kp_tree_set_deep(users,array[resident,'notifications','news_'||p_news_id],
         jsonb_build_object('id','news_'||p_news_id,'text','Новая новость «'||left(item->>'title',100)||'»',
           'type','news','read',false,'seen',false,'createdAt',now_ms,
           'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI')));
     end if;
   end loop;
   perform public.kp_v8_put('users',users);
   return item;
 elsif p_action='delete' then
   if item is null then return jsonb_build_object('deleted',true);end if;
   if a<>'Кайон' and item->>'author'<>a then raise exception 'News author required';end if;
   perform public.kp_v8_put('news',coalesce(news,'{}')-p_news_id);
   return jsonb_build_object('deleted',true);
 end if;
 if item is null then raise exception 'News not found';end if;
 if p_action<>'read' and coalesce(p_message_id,'') !~ '^[A-Za-z0-9_-]{8,100}$' then
   raise exception 'Invalid discussion message ID';end if;
 select document into discussions from public.kp_tree_roots where branch='newsDiscussions' for update;
 discussions:=coalesce(discussions,'{}'::jsonb);
 if p_action='read' then
   discussions:=public.kp_tree_set_deep(discussions,array[p_news_id,'lastRead',a],to_jsonb(now_ms));
   perform public.kp_v8_put('newsDiscussions',discussions);
   select document into users from public.kp_tree_roots where branch='users' for update;
   users:=public.kp_tree_set_deep(users,array[a,'newsRead',p_news_id],to_jsonb(now_ms));
   perform public.kp_v8_put('users',users);
   return jsonb_build_object('readAt',now_ms);
 end if;
 message:=discussions->p_news_id->'messages'->p_message_id;
 if p_action='comment_send' then
   if message is not null then
     if message->>'nick'=a then return message;end if;
     raise exception 'Discussion message ID conflict';
   end if;
   body:=trim(coalesce(p_data->>'text',''));
   image_url:=coalesce(p_data->>'mediaData','');
   msg_type:=coalesce(p_data->>'msgType',case when image_url<>'' then 'image' else 'text' end);
   if length(body)>4000 or (length(body)=0 and length(image_url)=0) or
     length(image_url)>2000000 or
     msg_type not in ('text','image','video','voice','video_circle') or
     (image_url<>'' and image_url !~ '^https://' and
       not(msg_type='image' and image_url ~ '^data:image/(png|jpeg|webp);base64,')) then
     raise exception 'Invalid discussion content';end if;
   message:=jsonb_build_object('id',p_message_id,'nick',a,
     'avatar',coalesce(actor->>'avatar','assets/avatar.svg'),'text',body,
     'mediaData',nullif(image_url,''),'msgType',msg_type,
     'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI'),'createdAt',now_ms);
   discussions:=public.kp_tree_set_deep(discussions,array[p_news_id,'messages',p_message_id],message);
 elsif p_action='comment_edit' then
   if message is null or message->>'nick'<>a then raise exception 'Message author required';end if;
   body:=trim(coalesce(p_data->>'text',''));
   if length(body) not between 1 and 4000 then raise exception 'Message text length invalid';end if;
   message:=message||jsonb_build_object('text',body,'edited',true);
   discussions:=public.kp_tree_set_deep(discussions,array[p_news_id,'messages',p_message_id],message);
 elsif p_action='comment_delete' then
   if message is null then return jsonb_build_object('deleted',true);end if;
   if message->>'nick'<>a and a<>'Кайон' then raise exception 'Message author required';end if;
   discussions:=discussions #- array[p_news_id,'messages',p_message_id];
 else raise exception 'Invalid news action';end if;
 perform public.kp_v8_put('newsDiscussions',discussions);
 if p_action='comment_send' and item->>'author' is distinct from a then
   perform public.kp_v8_notify(item->>'author','Новый комментарий к новости «'||left(item->>'title',65)||'»',
     'news','news_comment_'||p_message_id);
 end if;
 return case when p_action='comment_delete' then jsonb_build_object('deleted',true) else message end;
end; $$;

revoke all on function public.kp_subscription_v10(text,uuid,text,text),
 public.kp_news_v10(text,text,text,jsonb) from public,anon;
grant execute on function public.kp_subscription_v10(text,uuid,text,text),
 public.kp_news_v10(text,text,text,jsonb) to authenticated;
commit;
