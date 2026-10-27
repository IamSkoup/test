-- Install after 010 (uses kp_v8_money). See INSTALL.sql for the correct order.
begin;
create or replace function public.kp_v8_distance(a numeric,b numeric,c numeric,d numeric) returns numeric language sql immutable set search_path='' as $$
 select (6371*2*asin(least(1,sqrt(power(sin(radians((c-a)::double precision)/2),2)+cos(radians(a::double precision))*cos(radians(c::double precision))*power(sin(radians((d-b)::double precision)/2),2)))))::numeric;
$$;
create or replace function public.kp_service_v8(p_kind text,p_action text,p_id text,p_data jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor(); branch_name text; root jsonb; orders jsonb; o jsonb; users jsonb; u jsonb; b jsonb; item jsonb; m jsonb; doctor text; worker text; supplier text; price bigint; product_price bigint:=0; distance numeric; total bigint; at_ms bigint:=(extract(epoch from now())*1000)::bigint; expected text; entry record;
begin
 if a is null then raise exception 'Authentication required'; end if;
 if p_kind not in ('taxi','delivery','hospital') or length(coalesce(p_id,'')) not between 8 and 100 then raise exception 'Invalid service request'; end if;
 branch_name:=case p_kind when 'taxi' then 'orders' when 'delivery' then 'deliveryCustomOrders' else 'hospital' end;
 insert into public.kp_tree_roots(branch) values('users'),(branch_name) on conflict do nothing;
 select document into users from public.kp_tree_roots where branch='users' for update; u:=users->a;
 select document into root from public.kp_tree_roots where branch=branch_name for update;
 orders:=case when p_kind='hospital' then coalesce(root->'appointments','{}') else root end;
 o:=orders->p_id;
 if p_action='create' then
   if o is not null then
     if coalesce(o->>'client',o->>'clientNick')<>a then raise exception 'Request belongs to another user'; end if;
     return o;
   end if;
   if coalesce(u->>'accountFrozen','false')='true' or coalesce(u->>'accountVerified','false')<>'true' then raise exception 'Verified active account required'; end if;
   if p_kind='hospital' then
     item:=root->'services'->(p_data->>'serviceId');
     select key into doctor from jsonb_each(users) where public.kp_v8_role(key,'Врач') order by key limit 1;
     if item is null or item->>'active'='false' or doctor is null or doctor=a then raise exception 'Service unavailable'; end if;
     if p_data->>'date' is null or (p_data->>'date')::date<(now() at time zone 'Europe/Moscow')::date or (p_data->>'date')::date>(now() at time zone 'Europe/Moscow')::date+90 or coalesce(p_data->>'time','')!~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid appointment time'; end if;
     if ((p_data->>'date')||' '||(p_data->>'time'))::timestamp <= now() at time zone 'Europe/Moscow' then raise exception 'Choose a future appointment'; end if;
     if exists(select 1 from jsonb_each(orders) e where e.value->>'doctorNick'=doctor and e.value->>'date'=p_data->>'date' and e.value->>'time'=p_data->>'time' and e.value->>'status' not in ('cancelled','rejected','paid')) then raise exception 'This time is already booked'; end if;
     price:=coalesce((item->>'price')::bigint,0);
     if price not between 0 and 10000 then raise exception 'Invalid service price'; end if;
     o:=jsonb_build_object('id',p_id,'client',a,'clientNick',a,'clientName',coalesce(u->>'displayName',a),'clientSurname','','worker',doctor,'doctorNick',doctor,'serviceId',p_data->>'serviceId','serviceName',item->>'name','price',price,'date',p_data->>'date','time',p_data->>'time','status','pending','paymentStatus','reserved');
   else
     if not public.kp_v8_point(p_data->>'destLat',p_data->>'destLng') then raise exception 'Select destination on map'; end if;
     if p_kind='taxi' then
       if not public.kp_v8_point(p_data->>'clientLat',p_data->>'clientLng') then raise exception 'Select pickup on map'; end if;
       if exists(select 1 from jsonb_each(orders) e where e.value->>'client'=a and e.value->>'type'='taxi' and e.value->>'status' not in ('paid','cancelled','completed')) then raise exception 'You already have an active ride'; end if;
       distance:=public.kp_v8_distance((p_data->>'clientLat')::numeric,(p_data->>'clientLng')::numeric,(p_data->>'destLat')::numeric,(p_data->>'destLng')::numeric);price:=greatest(1,round(distance*250)::bigint);
       o:=jsonb_build_object('id',p_id,'client',a,'type','taxi','status','pending','clientLat',p_data->'clientLat','clientLng',p_data->'clientLng','destLat',p_data->'destLat','destLng',p_data->'destLng','price',price,'distanceKm',distance,'info',left(coalesce(p_data->>'info','Поездка по карте'),400));
       select key into worker from jsonb_each(users) where key<>a and public.kp_v8_role(key,'Водитель') and value->'settings'->>'taxiOnline'='true' and coalesce((value->>'lastSeen')::bigint,0)>at_ms-120000 and not exists(select 1 from jsonb_each(orders) e where e.value->>'worker'=key and e.value->>'status' in ('accepted','driver_arriving','in_progress','waiting_payment')) order by key limit 1;
       if worker is not null then o:=o||jsonb_build_object('worker',worker,'status','driver_arriving','driverAvatar',users->worker->>'avatar','driverVehicle',users->worker->>'vehicle'); end if;
     else
       if p_data->>'source'='business' then
         select document->(p_data->>'bizId') into b from public.kp_tree_roots where branch='businesses';item:=b->'products'->(p_data->>'productId');
         if b is null or item is null or b->>'status'<>'active' or coalesce(b->>'delivery','false')<>'true' or item->>'available'='false' or not public.kp_v8_point(b->>'lat',b->>'lng') then raise exception 'Business or product unavailable for delivery'; end if;
         supplier:=b->>'owner';product_price:=(item->>'price')::bigint;
         if product_price is null or product_price not between 1 and 100000 then raise exception 'Invalid product price'; end if;
         o:=jsonb_build_object('source','business','bizId',p_data->>'bizId','productId',p_data->>'productId','from',b->>'name','items',item->>'name','productName',item->>'name','productPrice',product_price,'supplier',supplier,'pickupLat',b->'lat','pickupLng',b->'lng');
       elsif p_data->>'source'='marketplace' then
         select document->(p_data->>'listingId') into m from public.kp_tree_roots where branch='marketplace' for update;
         if m is null or not public.kp_v8_point(m->>'sellerLat',m->>'sellerLng') then raise exception 'Listing has no pickup point'; end if;
         if m->>'category' in ('service','work') then raise exception 'Only physical goods can be delivered'; end if;
         if exists(select 1 from jsonb_each(orders) e where e.value->>'listingId'=p_data->>'listingId' and e.value->>'status'<>'cancelled') then raise exception 'Delivery already exists for this purchase'; end if;
         if m->>'status'='meeting_confirmed' and m->>'buyer'=a then
           perform public.kp_market_action('purchase',p_data->>'listingId',coalesce(p_data->'purchase','{}'));
         elsif m->>'status'<>'sold' or m->>'buyer' is distinct from a then raise exception 'Seller must confirm the purchase first'; end if;
         o:=jsonb_build_object('source','marketplace','listingId',p_data->>'listingId','from',m->>'seller','items',m->>'title','listingTitle',m->>'title','pickupLat',m->'sellerLat','pickupLng',m->'sellerLng');
       else raise exception 'Select delivery source'; end if;
       if supplier=a then raise exception 'Cannot purchase your own product'; end if;
       distance:=public.kp_v8_distance((o->>'pickupLat')::numeric,(o->>'pickupLng')::numeric,(p_data->>'destLat')::numeric,(p_data->>'destLng')::numeric);price:=greatest(1,round(distance*200)::bigint);
       o:=o||jsonb_build_object('id',p_id,'client',a,'status','waiting','deliveryLat',p_data->'destLat','deliveryLng',p_data->'destLng','deliveryPrice',price,'priceOffer',price,'price',price,'distanceKm',distance,'address',left(coalesce(p_data->>'address','Точка на карте'),200),'notes',left(coalesce(p_data->>'notes',''),1000),'contact',left(coalesce(p_data->>'contact',''),100));
     end if;
     if distance<=0 or distance>100 then raise exception 'Route must be between 0 and 100 km'; end if;
   end if;
   total:=price+product_price;
   if total>0 then perform public.kp_v8_money(a,-total,(md5(p_kind||p_id||':reserve'))::uuid,'service_reserve',jsonb_build_object('service',p_kind,'order',p_id));end if;
   o:=o||jsonb_build_object('escrowAmount',total,'createdAt',at_ms,'updatedAt',at_ms,'clientConfirmed',false,'workerConfirmed',false);
 else
   if o is null then raise exception 'Order missing'; end if;
   worker:=o->>'worker';price:=(o->>'price')::bigint;
   if p_action='take' then
     if coalesce(o->>'client',o->>'clientNick')=a or not public.kp_v8_role(a,case when p_kind='taxi' then 'Водитель' else 'Доставщик' end) then raise exception 'Worker access required'; end if;
     if o->>'worker'=a then return o; end if;
     if o->>'status' not in ('pending','waiting') or worker is not null then raise exception 'Order already assigned'; end if;
     if exists(select 1 from jsonb_each(orders) e where e.value->>'worker'=a and e.value->>'status' in ('driver_arriving','accepted','client_confirmed','in_progress','waiting_payment','delivered')) then raise exception 'Finish your active order first'; end if;
     o:=o||jsonb_build_object('worker',a,'status',case when p_kind='taxi' then 'driver_arriving' else 'client_confirmed' end,'driverAvatar',u->>'avatar','driverVehicle',u->>'vehicle','acceptedAt',at_ms);
   elsif p_action='cancel' then
     if a is distinct from o->>'client' and a is distinct from worker and a<>'Кайон' and not(p_kind='hospital' and public.kp_v8_role(a,'Помощник врача')) then raise exception 'Not an order participant'; end if;
     if o->>'status' in ('cancelled','rejected') then return o; end if;
     if o->>'status' not in ('pending','waiting','accepted','driver_arriving','client_confirmed') then raise exception 'Cannot cancel after service has started'; end if;
     total:=coalesce((o->>'escrowAmount')::bigint,0);
     if total>0 then perform public.kp_v8_money(o->>'client',total,(md5(p_kind||p_id||':refund'))::uuid,'service_refund',jsonb_build_object('order',p_id));end if;
     o:=o||jsonb_build_object('status','cancelled','escrowAmount',0,'paymentStatus','refunded');
   elsif p_action='location' then
     if a is distinct from worker or p_kind='hospital' or o->>'status' not in ('driver_arriving','accepted','client_confirmed','in_progress') or not public.kp_v8_point(p_data->>'lat',p_data->>'lng') then raise exception 'Location update unavailable'; end if;
     o:=o||jsonb_build_object('driverLat',p_data->'lat','driverLng',p_data->'lng','driverLocationUpdatedAt',at_ms);
   elsif p_action='start' then
     if a is distinct from worker and not (p_kind='hospital' and public.kp_v8_role(a,'Помощник врача')) then raise exception 'Assigned worker required'; end if;
     expected:=case when p_kind='hospital' then 'accepted' else 'in_progress' end;
     if o->>'status'=expected then return o; end if;
     if o->>'status' not in ('pending','accepted','driver_arriving','client_confirmed') then raise exception 'Invalid order transition'; end if;
     o:=o||jsonb_build_object('status',expected);
   elsif p_action='finish' then
     if a is distinct from worker and not (p_kind='hospital' and public.kp_v8_role(a,'Помощник врача')) then raise exception 'Assigned worker required'; end if;
     expected:=case p_kind when 'hospital' then 'awaiting_confirmation' when 'taxi' then 'waiting_payment' else 'delivered' end;
     if o->>'status'=expected then return o; end if;
     if o->>'status'<>(case when p_kind='hospital' then 'accepted' else 'in_progress' end) then raise exception 'Service has not started'; end if;
     o:=o||jsonb_build_object('status',expected,'workerConfirmed',true,'doctorConfirmed',true);
   elsif p_action='confirm' then
     if a is distinct from o->>'client' then raise exception 'Client confirmation required'; end if;
     if o->>'status' in ('paid','done') then return o; end if;
     if o->>'status' not in ('waiting_payment','awaiting_confirmation','delivered') or worker is null then raise exception 'Worker must finish first'; end if;
     total:=coalesce((o->>'escrowAmount')::bigint,0);product_price:=coalesce((o->>'productPrice')::bigint,0);
     if total<>price+product_price then raise exception 'Escrow mismatch'; end if;
     if price>0 then perform public.kp_v8_money(worker,price,(md5(p_kind||p_id||':worker'))::uuid,'service_payout',jsonb_build_object('order',p_id));end if;
     if product_price>0 then perform public.kp_v8_money(o->>'supplier',product_price,(md5(p_kind||p_id||':product'))::uuid,'business_sale',jsonb_build_object('order',p_id));end if;
     o:=o||jsonb_build_object('status',case when p_kind='delivery' then 'done' else 'paid' end,'clientConfirmed',true,'clientReceived',true,'paymentStatus','paid','payoutDone',true,'escrowAmount',0,'paidAt',at_ms);
   else raise exception 'Unknown service action'; end if;
   o:=o||jsonb_build_object('updatedAt',at_ms);
 end if;
 orders:=jsonb_set(orders,array[p_id],o,true);
 if p_kind='hospital' then root:=jsonb_set(root,'{appointments}',orders,true);else root:=orders;end if;
 perform public.kp_v8_put(branch_name,root);
 if p_action<>'location' then
   perform public.kp_v8_notify(o->>'client',case p_kind when 'taxi' then 'Такси' when 'delivery' then 'Доставка' else 'Больница' end||': '||case p_action when 'create' then 'заказ создан, оплата зарезервирована' when 'cancel' then 'заказ отменён, оплата возвращена' when 'take' then 'исполнитель назначен' when 'start' then 'выполнение началось' when 'finish' then 'подтвердите получение услуги' else 'оплата завершена' end,'system',p_kind||'_'||p_id||'_'||p_action);
   if p_action in ('create','take') and o->>'worker' is not null then perform public.kp_v8_notify(o->>'worker','Новый заказ: '||case p_kind when 'taxi' then 'такси' when 'delivery' then 'доставка' else 'приём в больнице' end,'system',p_kind||'_'||p_id||'assigned');end if;
 end if;
 return o;
end; $$;
revoke all on function public.kp_v8_distance(numeric,numeric,numeric,numeric) from public,anon,authenticated;
revoke all on function public.kp_service_v8(text,text,text,jsonb) from public,anon;
grant execute on function public.kp_service_v8(text,text,text,jsonb) to authenticated;
commit;
