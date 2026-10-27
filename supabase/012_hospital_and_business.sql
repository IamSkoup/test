begin;
create or replace function public.kp_hospital_view() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();d jsonb;apps jsonb;assistant_apps jsonb;staff boolean;
begin
 if a is null then raise exception 'Authentication required';end if;
 select document into d from public.kp_tree_roots where branch='hospital';d:=coalesce(d,'{}');
 staff:=a='Кайон' or public.kp_v8_role(a,'Врач') or public.kp_v8_role(a,'Помощник врача');
 select coalesce(jsonb_object_agg(key,value),'{}') into apps from jsonb_each(coalesce(d->'appointments','{}')) where staff or value->>'clientNick'=a;
 select coalesce(jsonb_object_agg(key,value),'{}') into assistant_apps from jsonb_each(coalesce(d->'assistantApplications','{}')) where staff or value->>'from'=a;
 return jsonb_build_object('services',coalesce(d->'services','{}'),'photos',coalesce(d->'photos','{}'),'appointments',apps,'assistantApplications',assistant_apps,'assistantSalary',case when staff then coalesce(d->'assistantSalary','0') else '0'::jsonb end);
end; $$;
create or replace function public.kp_v8_notify(n text,t text,kind text,key text) returns void language plpgsql security definer set search_path='' as $$
declare d jsonb;at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 select document into d from public.kp_tree_roots where branch='users' for update;
 if d->n is null then return;end if;
 d:=public.kp_tree_set_deep(d,array[n,'notifications',key],jsonb_build_object('id',key,'text',left(t,500),'type',kind,'read',false,'seen',false,'createdAt',at_ms,'time',to_char(now() at time zone 'Europe/Moscow','HH24:MI')));
 perform public.kp_v8_put('users',d);
end; $$;
create or replace function public.kp_employment_v8(p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();u jsonb;root jsonb;b jsonb;app jsonb;apps jsonb;jobs jsonb;target text;role_id text;role_name text;branch_name text;path text[];limit_jobs integer;at_ms bigint:=(extract(epoch from now())*1000)::bigint;
begin
 if a is null or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid employment request';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 branch_name:=case when p_data->>'kind'='assistant' then 'hospital' else 'bizJobApps' end;
 insert into public.kp_tree_roots(branch) values(branch_name) on conflict do nothing;
 select document into root from public.kp_tree_roots where branch=branch_name for update;
 if branch_name='hospital' then
   path:=array['assistantApplications',p_id];role_name:='Помощник врача';
 else
   select document->(p_data->>'bizId') into b from public.kp_tree_roots where branch='businesses' for update;
   if b is null or b->>'status'<>'active' then raise exception 'Business unavailable';end if;
   path:=array[p_data->>'bizId',p_id];
 end if;
 app:=root #> path;
 if p_action='apply' then
   if app is not null then if app->>'from'=a then return app;else raise exception 'Duplicate application';end if;end if;
   if coalesce(u->a->>'accountVerified','false')<>'true' or u->a->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if exists(select 1 from jsonb_each(coalesce(root->path[1],'{}')) e where coalesce(e.value->>'from',e.value->>'applicant')=a and e.value->>'status'='pending') then raise exception 'Application already pending';end if;
   role_id:=p_data->>'roleId';
   if branch_name='hospital' then
     if coalesce((u->a->>'kveScore')::integer,0)<80 then raise exception 'KVE score 80 required';end if;
   else
     if b->>'owner'=a or b->'roles'->role_id is null then raise exception 'Select a vacancy';end if;
     role_name:=b->'roles'->role_id->>'name';
   end if;
   app:=jsonb_build_object('id',p_id,'from',a,'applicant',a,'bizId',p_data->>'bizId','roleId',role_id,'roleName',role_name,'text',left(coalesce(p_data->>'text',''),1200),'status','pending','createdAt',at_ms);
 else
   if branch_name='hospital' then
     if not public.kp_v8_role(a,'Врач') then raise exception 'Doctor access required';end if;
   elsif a is distinct from b->>'owner' and p_action<>'quit' then raise exception 'Business owner required';end if;
   if p_action in ('approve','reject') then
     if app is null then raise exception 'Application missing';end if;
     if app->>'status'<>'pending' then return app;end if;
     target:=coalesce(app->>'from',app->>'applicant');role_id:=app->>'roleId';role_name:=app->>'roleName';
   else target:=case when p_action='quit' then a else p_data->>'target' end;end if;
   jobs:=coalesce(u->target->'employments','[]');
   if p_action='approve' then
     limit_jobs:=case when coalesce((u->target->>'subscriptionExpiry')::timestamptz,now())>now() then case u->target->>'subscription' when 'plus' then 3 when 'ultra' then 4 when 'prime' then 5 else 2 end else 2 end;
     if jsonb_array_length(jobs)>=limit_jobs then raise exception 'Employment limit reached';end if;
     if branch_name='hospital' then
       if exists(select 1 from jsonb_each(u)e where public.kp_v8_role(e.key,'Помощник врача')) or coalesce((u->target->>'kveScore')::integer,0)<80 then raise exception 'Assistant unavailable';end if;
       jobs:=jobs||jsonb_build_array(jsonb_build_object('id','muni_Помощник врача','type','municipal','role','Помощник врача'));
     else
       if b->'roles'->role_id is null or b->'employees' ? target or (select count(*) from jsonb_object_keys(coalesce(b->'employees','{}')))>=coalesce((b->>'employeeLimit')::integer,5) then raise exception 'Vacancy unavailable';end if;
       b:=public.kp_tree_set_deep(b,array['employees',target],jsonb_build_object('roleId',role_id,'roleName',role_name,'joinedAt',at_ms));
       jobs:=jobs||jsonb_build_array(jsonb_build_object('id','biz_'||(p_data->>'bizId'),'type','business','bizId',p_data->>'bizId','bizName',b->>'name','role',role_name));
     end if;
     u:=jsonb_set(u,array[target],(u->target)||jsonb_build_object('employments',jobs,'displayJob',role_name)||case when branch_name='hospital' then jsonb_build_object('job','Помощник врача') else '{}'::jsonb end);
   elsif p_action in ('fire','quit') and branch_name<>'hospital' then
     if b->'employees'->target is null then raise exception 'Employee missing';end if;
     b:=b #- array['employees',target];
     select coalesce(jsonb_agg(value),'[]') into jobs from jsonb_array_elements(jobs) where value->>'bizId' is distinct from p_data->>'bizId';
     u:=jsonb_set(u,array[target],(u->target)||jsonb_build_object('employments',jobs,'displayJob',coalesce(jobs->0->>'role','Житель'),'employerBizId',null));
   elsif p_action<>'reject' then raise exception 'Unsupported employment action';end if;
   if p_action<>'reject' then perform public.kp_v8_put('users',u);end if;
   if branch_name<>'hospital' then
     select document into apps from public.kp_tree_roots where branch='businesses';perform public.kp_v8_put('businesses',jsonb_set(apps,array[p_data->>'bizId'],b));
   end if;
   app:=coalesce(app,'{}')||jsonb_build_object('status',case when p_action='approve' then 'approved' when p_action='reject' then 'rejected' else 'closed' end,'reviewedAt',at_ms);
   perform public.kp_v8_notify(target,'Заявка на работу: '||case when p_action='approve' then 'одобрена' when p_action='reject' then 'отклонена' else 'работа завершена' end,'system','employment_'||p_id||p_action);
 end if;
 if p_action='apply' then
   if branch_name='hospital' then select key into target from jsonb_each(u)e where public.kp_v8_role(e.key,'Врач') order by key limit 1;else target:=b->>'owner';end if;
   perform public.kp_v8_notify(target,'Новая заявка на работу от '||a,'system','employment_'||p_id);
 end if;
 root:=public.kp_tree_set_deep(root,path,app);perform public.kp_v8_put(branch_name,root);return app;
end; $$;
create or replace function public.kp_business_order_v8(p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();u jsonb;b jsonb;root jsonb;o jsonb;items jsonb:='[]';entry record;product jsonb;qty integer;total bigint:=0;owner text;at_ms bigint:=(extract(epoch from now())*1000)::bigint;bid text:=p_data->>'bizId';
begin
 if a is null or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid order';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 select document->bid into b from public.kp_tree_roots where branch='businesses' for update;
 if b is null then raise exception 'Business missing';end if;owner:=b->>'owner';
 insert into public.kp_tree_roots(branch) values('bizOrders') on conflict do nothing;
 select document into root from public.kp_tree_roots where branch='bizOrders' for update;o:=root->bid->p_id;
 if p_action='create' then
   if o is not null then if o->>'client'=a then return o;else raise exception 'Request mismatch';end if;end if;
   if b->>'status'<>'active' or owner=a or coalesce(u->a->>'accountVerified','false')<>'true' or u->a->>'accountFrozen'='true' then raise exception 'Purchase unavailable';end if;
   if coalesce(jsonb_typeof(p_data->'cart'),'null')<>'object' or (select count(*) from jsonb_object_keys(p_data->'cart')) not between 1 and 30 then raise exception 'Invalid cart';end if;
   for entry in select key,value from jsonb_each(p_data->'cart') loop
     qty:=(entry.value#>>'{}')::integer;product:=b->'products'->entry.key;
     if qty is null or qty not between 1 and 20 or product is null or product->>'available'='false' or product->>'price' is null or (product->>'price')::numeric not between 1 and 100000 then raise exception 'Product unavailable';end if;
     total:=total+qty*(product->>'price')::bigint;
     items:=items||jsonb_build_array(jsonb_build_object('productId',entry.key,'name',product->>'name','qty',qty,'price',(product->>'price')::bigint,'total',qty*(product->>'price')::bigint));
   end loop;
   if total>100000 then raise exception 'Order limit 100000';end if;
   perform public.kp_v8_money(a,-total,(md5(p_id||':biz-reserve'))::uuid,'business_order_reserve',jsonb_build_object('bizId',bid));
   o:=jsonb_build_object('id',p_id,'bizId',bid,'bizName',b->>'name','client',a,'clientNick',a,'owner',owner,'items',items,'total',total,'amount',total,'status','paid_waiting_receipt','escrowAmount',total,'clientConfirmed',false,'ownerConfirmed',false,'createdAt',at_ms);
 elsif p_action='confirm' then
   if o is null or (a is distinct from o->>'client' and a<>owner) then raise exception 'Order participant required';end if;
   if o->>'status'='completed' then return o;end if;
   if o->>'status'<>'paid_waiting_receipt' then raise exception 'Invalid order state';end if;
   o:=o||case when a=owner then '{"ownerConfirmed":true}'::jsonb else '{"clientConfirmed":true}'::jsonb end;
   if o->>'ownerConfirmed'='true' and o->>'clientConfirmed'='true' then
     perform public.kp_v8_money(owner,(o->>'escrowAmount')::bigint,(md5(p_id||':biz-paid'))::uuid,'business_sale',jsonb_build_object('bizId',bid));
     o:=o||jsonb_build_object('status','completed','escrowAmount',0,'payoutDone',true,'paidAt',at_ms);
   end if;
 elsif p_action='cancel' then
   if o is null or a is distinct from o->>'client' then raise exception 'Client required';end if;
   if o->>'status'='cancelled' then return o;end if;
   if o->>'status'<>'paid_waiting_receipt' or o->>'ownerConfirmed'='true' then raise exception 'Order already handed over';end if;
   perform public.kp_v8_money(a,(o->>'escrowAmount')::bigint,(md5(p_id||':biz-refund'))::uuid,'business_order_refund');o:=o||'{"status":"cancelled","escrowAmount":0}';
 else raise exception 'Unknown order action';end if;
 root:=public.kp_tree_set_deep(root,array[bid,p_id],o);perform public.kp_v8_put('bizOrders',root);
 perform public.kp_v8_notify(case when a=owner then o->>'client' else owner end,'Заказ в «'||(b->>'name')||'»: '||case when p_action='create' then 'новый заказ' when p_action='cancel' then 'отменён' else 'получение подтверждено' end,'system','bizorder_'||p_id||p_action||a);
 return o;
end; $$;
revoke all on function public.kp_v8_notify(text,text,text,text) from public,anon,authenticated;
revoke all on function public.kp_employment_v8(text,text,jsonb),public.kp_business_order_v8(text,text,jsonb) from public,anon;
grant execute on function public.kp_employment_v8(text,text,jsonb),public.kp_business_order_v8(text,text,jsonb) to authenticated;
commit;
