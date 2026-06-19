create extension if not exists pgcrypto;

create table if not exists public.strike_rush_rooms (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.strike_rush_room_secrets (
  code text primary key references public.strike_rush_rooms(code) on delete cascade,
  host_token_hash bytea not null
);

create table if not exists public.strike_rush_player_secrets (
  code text not null references public.strike_rush_rooms(code) on delete cascade,
  client_id text not null,
  player_token_hash bytea not null,
  primary key (code, client_id)
);

alter table public.strike_rush_rooms enable row level security;
alter table public.strike_rush_room_secrets enable row level security;
alter table public.strike_rush_player_secrets enable row level security;
revoke all on public.strike_rush_rooms from anon, authenticated;
revoke all on public.strike_rush_room_secrets from anon, authenticated;
revoke all on public.strike_rush_player_secrets from anon, authenticated;
grant select on public.strike_rush_rooms to anon, authenticated;

drop policy if exists "read active strike rush rooms" on public.strike_rush_rooms;
create policy "read active strike rush rooms" on public.strike_rush_rooms
for select to anon, authenticated using (expires_at > now());

create or replace function public.strike_rush_now_ms()
returns bigint language sql stable
as $$ select floor(extract(epoch from clock_timestamp()) * 1000)::bigint $$;

create or replace function public.strike_rush_clean_expired()
returns void language sql security definer set search_path = public
as $$ delete from public.strike_rush_rooms where expires_at <= now() $$;

create or replace function public.strike_rush_create_room(p_code text, p_host_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_state jsonb;
begin
  perform public.strike_rush_clean_expired();
  if p_code !~ '^[A-Z0-9]{6}$' then raise exception 'Code invalide'; end if;
  v_state := jsonb_build_object(
    'code', p_code, 'createdAt', public.strike_rush_now_ms(), 'updatedAt', public.strike_rush_now_ms(),
    'phase', 'lobby', 'frame', 0, 'bettingEndsAt', 0, 'bowler', 'Joueur libre',
    'players', '{}'::jsonb, 'bets', '{}'::jsonb, 'chats', '[]'::jsonb, 'lastResult', null
  );
  insert into public.strike_rush_rooms(code, state) values (p_code, v_state);
  insert into public.strike_rush_room_secrets(code, host_token_hash)
  values (p_code, digest(p_host_token::text, 'sha256'));
  return v_state;
exception when unique_violation then raise exception 'Code de lobby indisponible';
end $$;

create or replace function public.strike_rush_get_room(p_code text)
returns jsonb language sql security definer set search_path = public
as $$ select state from public.strike_rush_rooms where code = upper(p_code) and expires_at > now() $$;

create or replace function public.strike_rush_join(
  p_code text, p_client_id text, p_player_token uuid, p_nickname text, p_avatar text, p_color text
) returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_state jsonb; v_player jsonb;
begin
  select state into v_state from public.strike_rush_rooms
  where code = upper(p_code) and expires_at > now() for update;
  if v_state is null then raise exception 'Partie introuvable ou expirée'; end if;
  if v_state->>'phase' <> 'lobby' then raise exception 'La partie a déjà commencé'; end if;
  if length(trim(p_nickname)) < 3 or length(trim(p_nickname)) > 12
    then raise exception 'Pseudo invalide'; end if;
  if not (v_state->'players' ? p_client_id)
    and (select count(*) from jsonb_object_keys(v_state->'players')) >= 9
    then raise exception 'Ce lobby est complet'; end if;
  insert into public.strike_rush_player_secrets(code, client_id, player_token_hash)
  values (upper(p_code), p_client_id, digest(p_player_token::text, 'sha256'))
  on conflict (code, client_id) do update
  set player_token_hash = excluded.player_token_hash;
  v_player := jsonb_build_object(
    'id', p_client_id, 'nickname', upper(trim(p_nickname)), 'avatar', left(p_avatar, 4),
    'color', left(p_color, 9), 'credits', 1000, 'streak', 0, 'bestStreak', 0,
    'totalWon', 0, 'correct', 0, 'bets', 0, 'joinedAt', public.strike_rush_now_ms()
  );
  v_state := jsonb_set(v_state, array['players', p_client_id], v_player, true);
  v_state := jsonb_set(v_state, '{updatedAt}', to_jsonb(public.strike_rush_now_ms()));
  update public.strike_rush_rooms set state = v_state, updated_at = now() where code = upper(p_code);
  return v_state;
end $$;

create or replace function public.strike_rush_host_action(
  p_code text, p_host_token uuid, p_action text, p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_state jsonb; v_frame int; v_type text; v_pins int; v_player_id text;
  v_player jsonb; v_bet jsonb; v_won boolean; v_streak int; v_multiplier int; v_reward int;
begin
  if not exists (
    select 1 from public.strike_rush_room_secrets
    where code = upper(p_code) and host_token_hash = digest(p_host_token::text, 'sha256')
  ) then raise exception 'Hôte non autorisé'; end if;
  select state into v_state from public.strike_rush_rooms
  where code = upper(p_code) and expires_at > now() for update;
  if v_state is null then raise exception 'Partie introuvable ou expirée'; end if;

  if p_action = 'start' then
    if (select count(*) from jsonb_object_keys(v_state->'players')) = 0 then raise exception 'Ajoutez au moins un joueur'; end if;
    v_state := jsonb_set(v_state, '{phase}', '"waiting"');
  elsif p_action = 'open-betting' then
    v_frame := (v_state->>'frame')::int;
    if v_frame >= 10 then raise exception 'Les 10 frames sont terminées'; end if;
    v_state := jsonb_set(v_state, '{frame}', to_jsonb(v_frame + 1));
    v_state := jsonb_set(v_state, '{phase}', '"betting"');
    v_state := jsonb_set(v_state, '{bets}', '{}'::jsonb);
    v_state := jsonb_set(v_state, '{lastResult}', 'null'::jsonb);
    v_state := jsonb_set(v_state, '{bowler}', to_jsonb(coalesce(nullif(p_payload->>'bowler',''), 'Joueur libre')));
    v_state := jsonb_set(v_state, '{bettingEndsAt}', to_jsonb(public.strike_rush_now_ms() + 20000));
  elsif p_action = 'result' then
    if v_state->>'phase' <> 'betting' then raise exception 'La fenêtre de mise est fermée'; end if;
    v_type := case when p_payload->>'type' in ('pins','spare','strike') then p_payload->>'type' else 'pins' end;
    v_pins := greatest(0, least(10, coalesce((p_payload->>'pins')::int, 0)));
    for v_player_id, v_player in select key, value from jsonb_each(v_state->'players') loop
      v_bet := v_state->'bets'->v_player_id;
      if v_bet is null then continue; end if;
      v_won := case
        when v_bet->>'prediction' = 'strike' then v_type = 'strike' or v_pins = 10
        when v_bet->>'prediction' = 'spare' then v_type = 'spare'
        when v_bet->>'prediction' = '0' then v_type = 'pins' and v_pins = 0
        else v_type = 'pins' and v_pins between 1 and 9 end;
      if v_won then
        v_streak := (v_player->>'streak')::int + 1;
        v_multiplier := case when coalesce((v_bet->>'power')::boolean, false) then 5
          when v_streak >= 4 then 5 when v_streak = 3 then 3 when v_streak = 2 then 2 else 1 end;
        v_reward := (v_bet->>'stake')::int * (1 + v_multiplier);
        v_player := jsonb_set(v_player, '{streak}', to_jsonb(v_streak));
        v_player := jsonb_set(v_player, '{bestStreak}', to_jsonb(greatest((v_player->>'bestStreak')::int, v_streak)));
        v_player := jsonb_set(v_player, '{correct}', to_jsonb((v_player->>'correct')::int + 1));
        v_player := jsonb_set(v_player, '{credits}', to_jsonb((v_player->>'credits')::int + v_reward));
        v_player := jsonb_set(v_player, '{totalWon}', to_jsonb((v_player->>'totalWon')::int + v_reward));
      else
        v_streak := 0; v_reward := 0;
        v_player := jsonb_set(v_player, '{streak}', '0'::jsonb);
      end if;
      v_player := jsonb_set(v_player, '{bets}', to_jsonb((v_player->>'bets')::int + 1));
      v_bet := jsonb_set(v_bet, '{won}', to_jsonb(v_won));
      v_bet := jsonb_set(v_bet, '{reward}', to_jsonb(v_reward));
      v_state := jsonb_set(v_state, array['players', v_player_id], v_player);
      v_state := jsonb_set(v_state, array['bets', v_player_id], v_bet);
    end loop;
    v_state := jsonb_set(v_state, '{lastResult}', jsonb_build_object('type',v_type,'pins',v_pins,'at',public.strike_rush_now_ms()));
    v_state := jsonb_set(v_state, '{bettingEndsAt}', '0'::jsonb);
    v_state := jsonb_set(v_state, '{phase}', to_jsonb((case when (v_state->>'frame')::int >= 10 then 'finished' else 'result' end)::text));
  elsif p_action = 'new-lobby' then
    delete from public.strike_rush_rooms where code = upper(p_code);
    return null;
  else raise exception 'Action inconnue';
  end if;
  v_state := jsonb_set(v_state, '{updatedAt}', to_jsonb(public.strike_rush_now_ms()));
  update public.strike_rush_rooms set state = v_state, updated_at = now() where code = upper(p_code);
  return v_state;
end $$;

create or replace function public.strike_rush_place_bet(
  p_code text, p_client_id text, p_player_token uuid, p_prediction text, p_stake int,
  p_power boolean default false, p_target text default ''
) returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_state jsonb; v_player jsonb; v_stake int; v_power boolean; v_bet jsonb;
begin
  if not exists (
    select 1 from public.strike_rush_player_secrets where code = upper(p_code)
    and client_id = p_client_id and player_token_hash = digest(p_player_token::text, 'sha256')
  ) then raise exception 'Joueur non autorisé'; end if;
  select state into v_state from public.strike_rush_rooms
  where code = upper(p_code) and expires_at > now() for update;
  v_player := v_state->'players'->p_client_id;
  if v_player is null then raise exception 'Joueur non autorisé'; end if;
  if v_state->>'phase' <> 'betting' or public.strike_rush_now_ms() >= (v_state->>'bettingEndsAt')::bigint
    then raise exception 'La fenêtre de mise est fermée'; end if;
  if v_state->'bets' ? p_client_id then raise exception 'Une seule mise est autorisée'; end if;
  if p_prediction not in ('0','1-9','spare','strike') then raise exception 'Prédiction invalide'; end if;
  v_stake := round(p_stake / 10.0) * 10;
  if v_stake < 10 or v_stake > 500 or v_stake > (v_player->>'credits')::int
    then raise exception 'Mise invalide'; end if;
  v_power := p_power and (v_player->>'streak')::int >= 3;
  v_player := jsonb_set(v_player, '{credits}', to_jsonb((v_player->>'credits')::int - v_stake));
  v_bet := jsonb_build_object(
    'playerId', p_client_id, 'prediction', p_prediction, 'stake', v_stake,
    'power', v_power, 'target', case when v_power then left(p_target,12) else v_state->>'bowler' end,
    'placedAt', public.strike_rush_now_ms()
  );
  v_state := jsonb_set(v_state, array['players',p_client_id], v_player);
  v_state := jsonb_set(v_state, array['bets',p_client_id], v_bet);
  v_state := jsonb_set(v_state, '{updatedAt}', to_jsonb(public.strike_rush_now_ms()));
  update public.strike_rush_rooms set state = v_state, updated_at = now() where code = upper(p_code);
  return v_state;
end $$;

create or replace function public.strike_rush_chat(
  p_code text, p_client_id text, p_player_token uuid, p_message text
)
returns jsonb language plpgsql security definer set search_path = public, extensions
as $$
declare v_state jsonb; v_player jsonb; v_chats jsonb; v_last jsonb;
begin
  if not exists (
    select 1 from public.strike_rush_player_secrets where code = upper(p_code)
    and client_id = p_client_id and player_token_hash = digest(p_player_token::text, 'sha256')
  ) then raise exception 'Joueur non autorisé'; end if;
  if p_message not in ('Strike !','Oh non...','Il est chaud','Bluffeur') then raise exception 'Message invalide'; end if;
  select state into v_state from public.strike_rush_rooms
  where code = upper(p_code) and expires_at > now() for update;
  v_player := v_state->'players'->p_client_id;
  if v_player is null then raise exception 'Joueur non autorisé'; end if;
  v_chats := coalesce(v_state->'chats','[]'::jsonb);
  if jsonb_array_length(v_chats) > 0 then
    v_last := v_chats->(jsonb_array_length(v_chats)-1);
    if v_last->>'playerId' = p_client_id and public.strike_rush_now_ms() - (v_last->>'at')::bigint < 1500
      then raise exception 'Chat trop rapide'; end if;
  end if;
  if jsonb_array_length(v_chats) >= 8 then v_chats := v_chats - 0; end if;
  v_chats := v_chats || jsonb_build_array(jsonb_build_object(
    'playerId',p_client_id,'nickname',v_player->>'nickname','message',p_message,'at',public.strike_rush_now_ms()
  ));
  v_state := jsonb_set(v_state, '{chats}', v_chats);
  update public.strike_rush_rooms set state = v_state, updated_at = now() where code = upper(p_code);
  return v_state;
end $$;

revoke all on function public.strike_rush_now_ms() from public;
revoke all on function public.strike_rush_clean_expired() from public;
revoke all on function public.strike_rush_create_room(text,uuid) from public;
revoke all on function public.strike_rush_get_room(text) from public;
revoke all on function public.strike_rush_join(text,text,uuid,text,text,text) from public;
revoke all on function public.strike_rush_host_action(text,uuid,text,jsonb) from public;
revoke all on function public.strike_rush_place_bet(text,text,uuid,text,int,boolean,text) from public;
revoke all on function public.strike_rush_chat(text,text,uuid,text) from public;

grant execute on function public.strike_rush_create_room(text,uuid) to anon, authenticated;
grant execute on function public.strike_rush_get_room(text) to anon, authenticated;
grant execute on function public.strike_rush_join(text,text,uuid,text,text,text) to anon, authenticated;
grant execute on function public.strike_rush_host_action(text,uuid,text,jsonb) to anon, authenticated;
grant execute on function public.strike_rush_place_bet(text,text,uuid,text,int,boolean,text) to anon, authenticated;
grant execute on function public.strike_rush_chat(text,text,uuid,text) to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.strike_rush_rooms;
exception when duplicate_object then null;
end $$;
