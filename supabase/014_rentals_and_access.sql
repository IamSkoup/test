-- Additional protected rental operations. Requires migrations 001-013.
begin;
create table if not exists public.kp_v8_rental_ops(
 id uuid primary key,actor text not null,building_id text not null,
 action text not null,result jsonb not null,created_at timestamptz not null default now()
);
alter table public.kp_v8_rental_ops enable row level security;
revoke all on public.kp_v8_rental_ops from public,anon,authenticated;

create or replace function public.kp_rental_v8(p_action text,p_id uuid,p_building text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();users jsonb;u jsonb;buildings jsonb;b jsonb;
 old public.kp_v8_rental_ops%rowtype;price bigint;discount numeric:=0;
 now_ms bigint:=(extract(epoch from now())*1000)::bigint;result jsonb;previous text;
begin
 if a is null or p_id is null or coalesce(p_building,'') !~ '^[A-Za-z0-9_-]{8,100}$'
    or p_action not in ('rent','revoke') then raise exception 'Invalid rental request';end if;
 select document into users from public.kp_tree_roots where branch='users' for update;
 u:=users->a;
 select * into old from public.kp_v8_rental_ops where id=p_id;
 if found then
   if old.actor<>a or old.action<>p_action or old.building_id<>p_building then raise exception 'Rental request mismatch';end if;
   return old.result;
 end if;
 select document into buildings from public.kp_tree_roots where branch='rentBuildings' for update;
 b:=buildings->p_building;
 if b is null then raise exception 'Building missing';end if;
 if p_action='rent' then
   if coalesce(u->>'accountVerified','false')<>'true' or u->>'accountFrozen'='true' then raise exception 'Verified active account required';end if;
   if nullif(b->>'renter','') is not null and coalesce((b->>'rentExpiry')::bigint,0)>now_ms then raise exception 'Building is currently rented';end if;
   price:=coalesce((b->>'weekPrice')::bigint,0);
   if price not between 1 and 100000 then raise exception 'Invalid weekly price';end if;
   if coalesce((u->>'subscriptionExpiry')::timestamptz,now()-interval '1 day')>now() then
     discount:=case u->>'subscription' when 'prime' then .35 when 'ultra' then .20 else 0 end;
   end if;
   price:=greatest(1,round(price*(1-discount))::bigint);
   perform public.kp_v8_money(a,-price,p_id,'rental_payment',jsonb_build_object('buildingId',p_building));
   b:=b||jsonb_build_object('renter',a,'renterName',coalesce(u->>'displayName',a),
      'rentedAt',now_ms,'rentExpiry',now_ms+604800000,'lastRentPaid',price);
   result:=jsonb_build_object('buildingId',p_building,'renter',a,'paid',price,'rentExpiry',now_ms+604800000);
 else
   if a<>'Кайон' then raise exception 'Mayor access required';end if;
   previous:=b->>'renter';
   b:=b||jsonb_build_object('renter','','renterName','','rentedAt',0,'rentExpiry',0);
   result:=jsonb_build_object('buildingId',p_building,'revoked',true,'previousRenter',previous);
 end if;
 buildings:=jsonb_set(buildings,array[p_building],b,true);
 perform public.kp_v8_put('rentBuildings',buildings);
 insert into public.kp_v8_rental_ops(id,actor,building_id,action,result)
   values(p_id,a,p_building,p_action,result);
 if p_action='rent' then
   perform public.kp_v8_notify(a,'Аренда «'||coalesce(b->>'name','Здание')||'» оформлена на семь суток','system','rental_'||p_id::text);
 elsif nullif(previous,'') is not null then
   perform public.kp_v8_notify(previous,'Мэрия завершила аренду «'||coalesce(b->>'name','Здание')||'»','system','rental_revoke_'||p_id::text);
 end if;
 return result;
end; $$;

-- The previous helper combined private licence data without checking the
-- target role. Do not let an authenticated resident enumerate neighbours.
create or replace function public.kp_license_status(p_target text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a text:=public.kp_v8_actor();d jsonb;u jsonb;
begin
 if a is null or p_target is null or not(a=p_target or a='Кайон'
    or public.kp_v8_role(a,'КСБ') or public.kp_v8_role(a,'Полицейский')) then
   raise exception 'Private licence data';end if;
 select document->p_target into d from public.kp_tree_roots where branch='licenses';
 select document->p_target->'licenses' into u from public.kp_tree_roots where branch='users';
 return coalesce(u,'{}'::jsonb)||coalesce(d,'{}'::jsonb);
end; $$;

revoke all on function public.kp_rental_v8(text,uuid,text),public.kp_license_status(text) from public,anon;
grant execute on function public.kp_rental_v8(text,uuid,text),public.kp_license_status(text) to authenticated;
commit;
