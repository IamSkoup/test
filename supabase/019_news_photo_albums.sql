-- Kapani v15. Published news may contain a gallery of up to eight photographs.
-- The original news RPC continues to own role checks, formatting and in-app
-- notifications. Both operations run within one PostgreSQL transaction.

create or replace function public.kp_news_publish_v15(
  p_news_id text,
  p_data jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  images jsonb := coalesce(p_data->'images','[]'::jsonb);
  image jsonb;
  url text;
  item jsonb;
  news_doc jsonb;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Invalid news data';
  end if;
  if jsonb_typeof(images) <> 'array' or jsonb_array_length(images) > 8 then
    raise exception 'News supports a maximum of eight images';
  end if;
  for image in select value from jsonb_array_elements(images) loop
    if jsonb_typeof(image) <> 'string' then
      raise exception 'Invalid news image';
    end if;
    url := trim(image #>> '{}');
    if length(url) > 1500 or url !~ '^https://' then
      raise exception 'News photos must have secure image URLs';
    end if;
  end loop;

  -- A failure in the following update also rolls back the original publish.
  item := public.kp_news_v10('publish',p_news_id,null,p_data);
  if item->>'author' is distinct from public.kp_v8_actor() then
    raise exception 'Only the author can attach news images';
  end if;
  item := item || jsonb_build_object('images',images);
  select root.document into news_doc from public.kp_tree_roots root
    where root.branch='news' for update;
  perform public.kp_v8_put('news',jsonb_set(coalesce(news_doc,'{}'::jsonb),array[p_news_id],item,true));
  return item;
end;
$$;

revoke all on function public.kp_news_publish_v15(text,jsonb) from public,anon;
grant execute on function public.kp_news_publish_v15(text,jsonb) to authenticated;
