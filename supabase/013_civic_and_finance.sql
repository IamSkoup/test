begin;
create table if not exists public.kp_v8_finance_ops(id uuid primary key,actor text not null,args jsonb not null,result jsonb not null,created_at timestamptz default now());
alter table public.kp_v8_finance_ops enable row level security;
revoke all on public.kp_v8_finance_ops from anon,authenticated;
create or replace function public.kp_business_finance_v8(p_action text,p_id uuid,p_biz text default null,p_amount bigint default 0,p_target text default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();d jsonb;u jsonb;b jsonb;bal bigint;args jsonb;result jsonb;old public.kp_v8_finance_ops%rowtype;receiver text;
begin
 if a is null or p_id is null or p_amount is null or p_amount not between 1 and 100000 then raise exception 'Amount must be 1 to 100000';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 args:=jsonb_build_object('action',p_action,'biz',p_biz,'amount',p_amount,'target',p_target);
 select * into old from public.kp_v8_finance_ops where id=p_id;
 if found then if old.actor<>a or old.args<>args then raise exception 'Request mismatch';end if;return old.result;end if;
 if coalesce(u->a->>'accountFrozen','false')='true' then raise exception 'Account frozen';end if;
 if p_action='assistant_salary' then
   if not public.kp_v8_role(a,'Врач') or not public.kp_v8_role(p_target,'Помощник врача') then raise exception 'Doctor and assistant required';end if;
   perform public.kp_v8_money(a,-p_amount,p_id,'assistant_salary_out');
   perform public.kp_v8_money(p_target,p_amount,(md5(p_id::text||':salary'))::uuid,'assistant_salary_in');bal:=null;
 else
   select document into d from public.kp_tree_roots where branch='businesses' for update;b:=d->p_biz;
   if b is null or b->>'owner' is distinct from a or b->>'status'<>'active' then raise exception 'Active business owner required';end if;
   bal:=coalesce((b->>'balance')::bigint,0);
   if p_action='deposit' then
     perform public.kp_v8_money(a,-p_amount,p_id,'business_deposit',jsonb_build_object('bizId',p_biz));bal:=bal+p_amount;
   elsif p_action in ('withdraw','salary') then
     if bal<p_amount then raise exception 'Insufficient business funds';end if;
     receiver:=case when p_action='withdraw' then a else p_target end;
     if p_action='salary' and (p_target is null or b->'employees'->p_target is null) then raise exception 'Employee required';end if;
     perform public.kp_v8_money(receiver,p_amount,p_id,'business_'||p_action,jsonb_build_object('bizId',p_biz));bal:=bal-p_amount;
   else raise exception 'Unknown business operation';end if;
   b:=b||jsonb_build_object('balance',bal);perform public.kp_v8_put('businesses',jsonb_set(d,array[p_biz],b));
 end if;
 result:=jsonb_build_object('ok',true,'balance',bal);
 insert into public.kp_v8_finance_ops(id,actor,args,result)values(p_id,a,args,result);
 if p_target is not null then perform public.kp_v8_notify(p_target,'Получена зарплата: '||p_amount||' ₽','money','salary_'||p_id::text);end if;
 return result;
end; $$;

-- All civic requests have one durable, reviewable record. Protected rewards
-- are paid once; changing status alone never mints money.
create or replace function public.kp_civic_v8(p_action text,p_kind text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();u jsonb;d jsonb;o jsonb;l jsonb;b jsonb;branch_name text;target text;fee bigint:=0;accepted boolean;at_ms bigint:=(extract(epoch from now())*1000)::bigint;op uuid;score integer;
begin
 if a is null or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid civic request';end if;
 branch_name:=case p_kind when 'janitor' then 'janitorSubmissions' when 'police' then 'policeRequests' when 'business_close' then 'bizDeleteRequests' else 'civicRequests' end;
 if p_kind not in ('janitor','police','business_close','education','bike','scooter') then raise exception 'Unknown request kind';end if;
 select document into u from public.kp_tree_roots where branch='users' for update;
 insert into public.kp_tree_roots(branch)values(branch_name),('licenses') on conflict do nothing;
 select document into d from public.kp_tree_roots where branch=branch_name for update;o:=d->p_id;
 if p_action='submit' then
   if o is not null then if o->>'from'=a or o->>'worker'=a then return o;else raise exception 'Request mismatch';end if;end if;
   if coalesce(u->a->>'accountVerified','false')<>'true' or u->a->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if exists(select 1 from jsonb_each(d)e where coalesce(e.value->>'from',e.value->>'worker')=a and coalesce(e.value->>'kind',p_kind)=p_kind and e.value->>'status'='pending') then raise exception 'Request already pending';end if;
   if p_kind in ('bike','scooter') then
     select document into l from public.kp_tree_roots where branch='licenses' for update;
     if l->a->>p_kind='true' then raise exception 'License already issued';end if;
     fee:=case when p_kind='bike' then 250 else 1500 end;
   elsif p_kind='education' then
     if u->a->'kEducationPurchase'->>'status' in ('paid','submitted','approved') then raise exception 'Education already paid';end if;fee:=2000;
   elsif p_kind='janitor' then
     if not public.kp_v8_role(a,'Уборщик') or length(coalesce(p_data->>'photo',''))<10 then raise exception 'Janitor and proof photo required';end if;
     if exists(select 1 from jsonb_each(d)e where e.value->>'worker'=a and e.value->>'date'=to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD') and e.value->>'status' in ('pending','approved')) then raise exception 'Today already submitted';end if;
   elsif p_kind='police' then
     if not(public.kp_v8_role(a,'КСБ') or public.kp_v8_role(a,'Полицейский')) or length(trim(coalesce(p_data->>'reason','')))<5 or u->(p_data->>'target') is null then raise exception 'Officer and valid request required';end if;
     if p_data->>'type' not in ('fine','freeze') then raise exception 'Only fine or freeze requests';end if;
     if p_data->>'type'='fine' and (p_data->>'amount' is null or (p_data->>'amount')::bigint not between 1 and 10000) then raise exception 'Fine must be 1 to 10000';end if;
   elsif p_kind='business_close' then
     select document->(p_data->>'bizId') into b from public.kp_tree_roots where branch='businesses';
     if b->>'owner' is distinct from a then raise exception 'Business owner required';end if;
   end if;
   if fee>0 then perform public.kp_v8_money(a,-fee,(md5(p_id||':civic-fee'))::uuid,'civic_fee',jsonb_build_object('kind',p_kind));end if;
   o:=jsonb_build_object('id',p_id,'kind',p_kind,'from',a,'worker',a,'officer',a,'owner',a,'status',case when p_kind='bike' then 'approved' else 'pending' end,'createdAt',at_ms,'feePaid',fee,'date',to_char(now() at time zone 'Europe/Moscow','YYYY-MM-DD'),'comment',left(coalesce(p_data->>'comment',''),1200),'photo',left(coalesce(p_data->>'photo',''),2500000),'target',p_data->>'target','type',p_data->>'type','amount',p_data->'amount','reason',left(coalesce(p_data->>'reason',''),1200),'bizId',p_data->>'bizId');
   select document into u from public.kp_tree_roots where branch='users';
   if p_kind='bike' then perform public.kp_v8_put('licenses',public.kp_tree_set_deep(l,array[a,'bike'],'true'));
   elsif p_kind='scooter' then u:=public.kp_tree_set_deep(u,array[a,'scooterLicenseApplication'],o);
   elsif p_kind='education' then u:=public.kp_tree_set_deep(u,array[a,'kEducationPurchase'],o||'{"status":"submitted"}');
   elsif p_kind='janitor' then u:=jsonb_set(u,array[a],(u->a)||jsonb_build_object('janitorSubmissionId',p_id,'janitorSubmissionStatus','pending'));end if;
   perform public.kp_v8_put('users',u);
 else
   if a<>'Кайон' or p_action not in ('approve','reject') or o is null then raise exception 'Mayor review required';end if;
   if o->>'status'<>'pending' then return o;end if;
   target:=coalesce(o->>'from',o->>'worker',o->>'owner',o->>'officer');accepted:=p_action='approve';op:=(md5(p_id||':civic-review'))::uuid;
   if p_kind='janitor' and accepted then
     perform public.kp_v8_money(target,500,op,'janitor_reward',jsonb_build_object('request',p_id));
   elsif p_kind='police' and accepted then
     if o->>'type'='fine' then perform public.kp_mayor_fine(o->>'target',(o->>'amount')::bigint,o->>'reason',op);
     else u:=public.kp_tree_set_deep(u,array[o->>'target','accountFrozen'],'true');perform public.kp_v8_put('users',u);end if;
   elsif p_kind='business_close' and accepted then
     select document into b from public.kp_tree_roots where branch='businesses' for update;
     -- Archive instead of deleting orders, staff or financial history.
     b:=public.kp_tree_set_deep(b,array[o->>'bizId','status'],'"archived"');perform public.kp_v8_put('businesses',b);
   elsif p_kind='scooter' and accepted then
     select document into l from public.kp_tree_roots where branch='licenses' for update;perform public.kp_v8_put('licenses',public.kp_tree_set_deep(l,array[target,'scooter'],'true'));
   elsif p_kind in ('education','scooter') and not accepted then
     fee:=coalesce((o->>'feePaid')::bigint,0);if fee>0 then perform public.kp_v8_money(target,fee,op,'civic_refund');end if;
   end if;
   o:=o||jsonb_build_object('status',case when accepted then 'approved' else 'rejected' end,'reviewedAt',at_ms,'adminComment',left(coalesce(p_data->>'comment',''),500));
   select document into u from public.kp_tree_roots where branch='users';
   if p_kind='education' then u:=public.kp_tree_set_deep(u,array[target,'kEducationPurchase'],o);
   elsif p_kind='scooter' then u:=public.kp_tree_set_deep(u,array[target,'scooterLicenseApplication'],o);
   elsif p_kind='janitor' then u:=jsonb_set(u,array[target],(u->target)||jsonb_build_object('janitorSubmissionStatus',o->>'status'));end if;
   perform public.kp_v8_put('users',u);
 end if;
 d:=jsonb_set(d,array[p_id],o,true);perform public.kp_v8_put(branch_name,d);
 perform public.kp_v8_notify(case when p_action='submit' then 'Кайон' else target end,'Заявка: '||case p_kind when 'education' then 'К-образование' when 'scooter' then 'права на скутер' when 'bike' then 'права на велосипед' when 'janitor' then 'отчёт уборщика' when 'police' then 'обращение полиции' else 'закрытие бизнеса' end||' — '||case when p_action='submit' then 'поступила' when p_action='approve' then 'одобрена' else 'отклонена' end,'system','civic_'||p_id||p_action);
 return o;
end; $$;
revoke all on function public.kp_business_finance_v8(text,uuid,text,bigint,text),public.kp_civic_v8(text,text,text,jsonb) from public,anon;
grant execute on function public.kp_business_finance_v8(text,uuid,text,bigint,text),public.kp_civic_v8(text,text,text,jsonb) to authenticated;
commit;
