-- Журналка: вход через Telegram Mini App и сессии сайта.
-- Применять к проду вручную ПОСЛЕ проверки. Этот файл сам ничего никуда не выкладывает.
-- Чистый Postgres (роли anon/authenticated/service_role — как у PostgREST). Без Supabase-специфики.
-- Повторный запуск безопасен: create or replace, add column if not exists.

-- ---------------------------------------------------------------------------
-- столбцы сессий и владельца
-- ---------------------------------------------------------------------------

alter table zh.owners add column if not exists disabled_at timestamptz;
alter table zh.owners add column if not exists platform_admin boolean not null default false;
alter table zh.owners add column if not exists role text not null default 'owner';

alter table zh.sessions add column if not exists id uuid default gen_random_uuid();
alter table zh.sessions add column if not exists kind text not null default 'web';
alter table zh.sessions add column if not exists tg_user_id bigint;
alter table zh.sessions add column if not exists device_key text;
alter table zh.sessions add column if not exists device_label text;
alter table zh.sessions add column if not exists created_ip_hash text;
alter table zh.sessions add column if not exists last_used_at timestamptz not null default now();
alter table zh.sessions add column if not exists abs_expires_at timestamptz;
alter table zh.sessions add column if not exists revoked_at timestamptz;
alter table zh.sessions add column if not exists revoke_reason text;
alter table zh.sessions add column if not exists refresh_hash text;
alter table zh.sessions add column if not exists refresh_expires_at timestamptz;
alter table zh.sessions add column if not exists rotated_at timestamptz;
alter table zh.sessions add column if not exists chain_id uuid default gen_random_uuid();
alter table zh.sessions add column if not exists grace_cipher text;
alter table zh.sessions add column if not exists grace_expires_at timestamptz;

update zh.sessions set id = gen_random_uuid() where id is null;
update zh.sessions set chain_id = gen_random_uuid() where chain_id is null;
update zh.sessions set kind = 'web' where kind is null;

create unique index if not exists zh_sessions_id_uq on zh.sessions (id);
create index if not exists zh_sessions_owner_idx on zh.sessions (owner_id);
create index if not exists zh_sessions_refresh_idx on zh.sessions (refresh_hash);
create index if not exists zh_sessions_chain_idx on zh.sessions (chain_id);
create index if not exists zh_sessions_tg_device_idx on zh.sessions (tg_user_id, device_key);

alter table zh.sessions drop constraint if exists zh_sessions_kind_chk;
alter table zh.sessions add constraint zh_sessions_kind_chk check (kind in ('web', 'tg', 'legacy'));
-- Старые токены сайта без refresh — единственные, которые можно обменять на cookie.
update zh.sessions
   set kind = 'legacy'
 where kind = 'web'
   and refresh_hash is null
   and tg_user_id is null;

alter table zh.login_attempts add column if not exists ip_hash text;
alter table zh.login_attempts add column if not exists kind text not null default 'password';
alter table zh.login_attempts add column if not exists tg_user_id bigint;
create index if not exists zh_login_attempts_email_idx on zh.login_attempts (kind, email, at);
create index if not exists zh_login_attempts_ip_idx on zh.login_attempts (kind, ip_hash, at);

-- ---------------------------------------------------------------------------
-- вход через Telegram — отдельно от zh.tg (чат отчётов)
-- ---------------------------------------------------------------------------

create table if not exists zh.tg_links (
  tg_user_id bigint primary key,
  owner_id uuid not null unique references zh.owners (id) on delete cascade,
  tg_username text,
  tg_first_name text,
  bound_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists zh.tg_link_codes (
  code_hash text primary key,
  owner_id uuid not null references zh.owners (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists zh_tg_link_codes_owner_idx on zh.tg_link_codes (owner_id, created_at);

create table if not exists zh.consents (
  id bigserial primary key,
  owner_id uuid not null references zh.owners (id) on delete cascade,
  kind text not null,
  version text not null,
  tg_user_id bigint,
  at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index if not exists zh_consents_owner_idx on zh.consents (owner_id, kind);

create table if not exists zh.tg_initdata_used (
  hash_sha256 text primary key,
  expires_at timestamptz not null
);

create table if not exists zh.auth_events (
  id bigserial primary key,
  owner_id uuid,
  kind text not null,
  tg_user_id bigint,
  ip_hash text,
  device_label text,
  at timestamptz not null default now()
);
create index if not exists zh_auth_events_at_idx on zh.auth_events (at);

create table if not exists zh.auth_alerts (
  id bigserial primary key,
  kind text not null,
  at timestamptz not null default now()
);

create table if not exists zh.owner_invites (
  code_hash text primary key,
  created_by uuid references zh.owners (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid,
  role text not null default 'owner'
);
alter table zh.owner_invites add column if not exists role text not null default 'owner';

create table if not exists zh.subscription (
  owner_id uuid primary key references zh.owners (id) on delete cascade,
  name text not null default 'Журналка',
  active boolean not null default true,
  until date
);

-- ---------------------------------------------------------------------------
-- владелец сессии: STABLE, ничего не пишет. Продление — отдельно, session_touch.
-- ---------------------------------------------------------------------------

create or replace function zh.owner_id(p_token text) returns uuid
language plpgsql stable security definer set search_path to pg_catalog as $$
declare
  v uuid;
  v_reason text;
  v_exp timestamptz;
  v_abs timestamptz;
  v_rev timestamptz;
  v_dis timestamptz;
begin
  if p_token is null or length(p_token) < 20 then
    raise exception 'Нужно войти' using hint = 'auth';
  end if;
  select s.owner_id into v
    from zh.sessions s
    join zh.owners o on o.id = s.owner_id
   where s.token_hash = zh.hash_token(p_token)
     and s.revoked_at is null
     and o.disabled_at is null
     and s.expires_at > now()
     and (s.abs_expires_at is null or s.abs_expires_at > now());
  if v is not null then
    return v;
  end if;
  select s.revoke_reason, s.expires_at, s.abs_expires_at, s.revoked_at, o.disabled_at
    into v_reason, v_exp, v_abs, v_rev, v_dis
    from zh.sessions s
    join zh.owners o on o.id = s.owner_id
   where s.token_hash = zh.hash_token(p_token);
  if not found then
    raise exception 'Нужно войти' using hint = 'auth';
  end if;
  if v_dis is not null then
    raise exception 'Аккаунт отключён' using hint = 'disabled';
  end if;
  if v_reason in ('logout', 'logout_all', 'password', 'admin', 'unbind', 'device_end', 'refresh_reuse')
     or (v_rev is not null and v_reason is distinct from 'rotated') then
    raise exception 'Сессия закончилась, войдите снова' using hint = 'revoked';
  end if;
  if v_reason = 'rotated' or v_exp <= now() or (v_abs is not null and v_abs <= now()) then
    raise exception 'Сессия устарела' using hint = 'expired';
  end if;
  raise exception 'Нужно войти' using hint = 'auth';
end $$;

create or replace function zh.session_touch(p_token text) returns void
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare s zh.sessions;
begin
  select * into s from zh.sessions
   where token_hash = zh.hash_token(p_token)
     and revoked_at is null
     and expires_at > now()
     and (abs_expires_at is null or abs_expires_at > now());
  if not found then
    return;
  end if;
  if s.kind = 'tg' and s.last_used_at < now() - interval '1 hour' then
    update zh.sessions
       set last_used_at = now(),
           expires_at = least(now() + interval '7 days', coalesce(abs_expires_at, now() + interval '7 days'))
     where token_hash = s.token_hash;
  elsif s.last_used_at < now() - interval '1 minute' then
    update zh.sessions set last_used_at = now() where token_hash = s.token_hash;
  end if;
end $$;

revoke all on function zh.session_touch(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- лимиты
-- ---------------------------------------------------------------------------

create or replace function zh.attempt_count(
  p_kind text, p_email text, p_ip text, p_tg bigint, p_window interval
) returns int
language sql stable security definer set search_path to pg_catalog as $$
  select count(*)::int from zh.login_attempts
   where kind = p_kind
     and at > now() - p_window
     and (p_email is null or email = p_email)
     and (p_ip is null or ip_hash = p_ip)
     and (p_tg is null or tg_user_id = p_tg)
$$;

create or replace function zh.wait_minutes(
  p_kind text, p_email text, p_ip text, p_tg bigint, p_window interval
) returns int
language sql stable security definer set search_path to pg_catalog as $$
  select greatest(1, coalesce(ceil(extract(epoch from (min(at) + p_window - now())) / 60)::int, 1))
    from zh.login_attempts
   where kind = p_kind
     and at > now() - p_window
     and (p_email is null or email = p_email)
     and (p_ip is null or ip_hash = p_ip)
     and (p_tg is null or tg_user_id = p_tg)
$$;

create or replace function zh.rate_msg(p_min int) returns text
language sql immutable set search_path to pg_catalog as $$
  select 'Слишком много попыток, подождите ' || greatest(coalesce(p_min, 1), 1)::text || ' мин'
$$;

revoke all on function zh.attempt_count(text, text, text, bigint, interval) from public, anon, authenticated;
revoke all on function zh.wait_minutes(text, text, text, bigint, interval) from public, anon, authenticated;

create or replace function zh.authenticate(p_email text, p_password text, p_ip_hash text)
returns jsonb
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  o zh.owners;
  n int;
begin
  n := zh.attempt_count('password', e, null, null, interval '15 minutes');
  if n >= 10 then
    return jsonb_build_object('error', zh.rate_msg(zh.wait_minutes('password', e, null, null, interval '15 minutes')), 'hint', 'rate');
  end if;
  if p_ip_hash is not null and zh.attempt_count('password', null, p_ip_hash, null, interval '15 minutes') >= 30 then
    return jsonb_build_object('error', zh.rate_msg(zh.wait_minutes('password', null, p_ip_hash, null, interval '15 minutes')), 'hint', 'rate');
  end if;
  select * into o from zh.owners where email = e;
  if not found or o.pass_hash <> extensions.crypt(coalesce(p_password, ''), o.pass_hash) then
    insert into zh.login_attempts (email, ip_hash, kind) values (e, p_ip_hash, 'password');
    insert into zh.auth_events (owner_id, kind, ip_hash) values (case when found then o.id else null end, 'login_fail', p_ip_hash);
    return jsonb_build_object('error', 'Неверная почта или пароль', 'hint', 'auth');
  end if;
  if o.disabled_at is not null then
    return jsonb_build_object('error', 'Аккаунт отключён', 'hint', 'disabled');
  end if;
  return jsonb_build_object('ok', true, 'id', o.id, 'email', o.email, 'name', o.name);
end $$;

revoke all on function zh.authenticate(text, text, text) from public, anon, authenticated;

create or replace function zh.issue_web(
  p_owner uuid, p_ip_hash text, p_device_label text, p_chain uuid
) returns jsonb
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare
  t text := zh.new_token();
  r text := zh.new_token();
  c uuid := coalesce(p_chain, gen_random_uuid());
  o zh.owners;
begin
  select * into o from zh.owners where id = p_owner;
  insert into zh.sessions (
    token_hash, refresh_hash, owner_id, expires_at, abs_expires_at, refresh_expires_at,
    kind, device_label, created_ip_hash, chain_id, last_used_at
  ) values (
    zh.hash_token(t), zh.hash_token(r), p_owner,
    now() + interval '15 minutes', now() + interval '15 minutes', now() + interval '365 days',
    'web', left(coalesce(p_device_label, ''), 80), p_ip_hash, c, now()
  );
  insert into zh.auth_events (owner_id, kind, ip_hash, device_label)
  values (p_owner, 'login_ok', p_ip_hash, left(coalesce(p_device_label, ''), 80));
  return jsonb_build_object('token', t, 'refresh', r, 'email', o.email, 'name', o.name, 'id', o.id);
end $$;

revoke all on function zh.issue_web(uuid, text, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- кабинет: прежние RPC, но сессия короткая, регистрация только по приглашению
-- ---------------------------------------------------------------------------

create or replace function public.zh_login(p_email text, p_password text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare a jsonb; t text;
begin
  a := zh.authenticate(p_email, p_password, null);
  if a ? 'error' then return a; end if;
  t := zh.new_token();
  insert into zh.sessions (token_hash, owner_id, expires_at, abs_expires_at, kind, last_used_at)
  values (zh.hash_token(t), (a->>'id')::uuid, now() + interval '15 minutes', now() + interval '15 minutes', 'web', now());
  return jsonb_build_object('token', t, 'email', a->>'email', 'name', a->>'name');
end $$;

create or replace function public.zh_register(p_email text, p_password text, p_name text default '') returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin
  return jsonb_build_object(
    'error', 'Регистрация только по приглашению — откройте ссылку от владельца',
    'hint', 'invite');
end $$;

create or replace function public.zh_logout(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin
  perform zh.owner_id(p_token);
  update zh.sessions
     set revoked_at = coalesce(revoked_at, now()),
         revoke_reason = case when revoke_reason is null then 'logout' else revoke_reason end,
         expires_at = least(expires_at, now())
   where token_hash = zh.hash_token(coalesce(p_token, ''));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.zh_me(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v_owner uuid := zh.owner_id(p_token); o zh.owners;
begin
  perform zh.session_touch(p_token);
  select * into o from zh.owners where id = v_owner;
  return jsonb_build_object(
    'email', o.email,
    'name', o.name,
    'plan', coalesce(
      (select jsonb_build_object('name', s.name, 'active', s.active, 'until', s.until)
         from zh.subscription s where s.owner_id = v_owner),
      jsonb_build_object('name', 'Журналка', 'active', true, 'until', null)),
    'tg', coalesce(
      (select jsonb_build_object('username', l.tg_username, 'first_name', l.tg_first_name, 'bound_at', l.bound_at)
         from zh.tg_links l where l.owner_id = v_owner),
      'null'::jsonb),
    'points', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'address', p.address, 'status', zh.today_status(p.id)
      ) order by p.created_at)
      from zh.points p where p.owner_id = v_owner and p.active), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- сайт: вход, обновление, регистрация по приглашению — только service_role
-- ---------------------------------------------------------------------------

create or replace function public.zh_web_login(
  p_email text, p_password text, p_ip_hash text, p_device_label text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare a jsonb;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  a := zh.authenticate(p_email, p_password, p_ip_hash);
  if a ? 'error' then return a; end if;
  return zh.issue_web((a->>'id')::uuid, p_ip_hash, p_device_label, null);
end $$;

create or replace function public.zh_web_register(
  p_email text, p_password text, p_name text, p_invite text, p_ip_hash text, p_device_label text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  o zh.owners;
  v_hash text;
  v_role text;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 200 then
    return jsonb_build_object('error', 'Проверьте адрес почты', 'hint', 'invalid');
  end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then
    return jsonb_build_object('error', 'Пароль — от 8 до 72 символов', 'hint', 'invalid');
  end if;
  if p_invite is null or length(trim(p_invite)) < 16 then
    return jsonb_build_object('error', 'Регистрация только по приглашению — откройте ссылку от владельца', 'hint', 'invite');
  end if;
  if exists (select 1 from zh.owners where email = e) then
    return jsonb_build_object('error', 'Эта почта уже зарегистрирована — войдите', 'hint', 'exists');
  end if;
  if (select count(*) from zh.owners where created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('error', 'Слишком много регистраций, попробуйте через час', 'hint', 'rate');
  end if;
  update zh.owner_invites
     set used_at = now()
   where code_hash = zh.hash_token(trim(p_invite))
     and used_at is null
     and expires_at > now()
  returning code_hash, role into v_hash, v_role;
  if v_hash is null then
    return jsonb_build_object('error', 'Ссылка-приглашение недействительна или уже использована', 'hint', 'invite');
  end if;
  begin
    insert into zh.owners (email, pass_hash, name, role)
    values (e, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), left(trim(coalesce(p_name, '')), 80), coalesce(nullif(v_role, ''), 'owner'))
    returning * into o;
    update zh.owner_invites set used_by = o.id where code_hash = v_hash;
  exception when unique_violation then
    return jsonb_build_object('error', 'Эта почта уже зарегистрирована — войдите', 'hint', 'exists');
  end;
  return zh.issue_web(o.id, p_ip_hash, p_device_label, null);
end $$;

create or replace function public.zh_migrate(
  p_token text, p_ip_hash text, p_device_label text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid; s zh.sessions; r jsonb;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  v := zh.owner_id(p_token);
  select * into s from zh.sessions where token_hash = zh.hash_token(p_token);
  if s.kind is distinct from 'legacy' then
    return jsonb_build_object('error', 'Этот токен нельзя обменять', 'hint', 'forbidden');
  end if;
  r := zh.issue_web(v, p_ip_hash, coalesce(p_device_label, s.device_label), s.chain_id);
  update zh.sessions
     set revoked_at = now(), revoke_reason = 'rotated', expires_at = least(expires_at, now())
   where token_hash = zh.hash_token(p_token);
  return r;
end $$;

create or replace function public.zh_web_refresh(
  p_refresh text, p_new_access text, p_new_refresh text, p_cipher text, p_device_label text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  s zh.sessions;
  o zh.owners;
  v_hash text;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  if p_refresh is null or length(p_refresh) < 20 or p_cipher is null or length(p_cipher) < 16 then
    return jsonb_build_object('status', 'invalid', 'hint', 'auth');
  end if;
  update zh.sessions
     set rotated_at = now(),
         revoked_at = now(),
         revoke_reason = 'rotated',
         grace_cipher = p_cipher,
         grace_expires_at = now() + interval '60 seconds'
   where refresh_hash = zh.hash_token(p_refresh)
     and revoked_at is null
     and kind = 'web'
     and refresh_expires_at > now()
  returning * into s;
  if found then
    insert into zh.sessions (
      token_hash, refresh_hash, owner_id, expires_at, abs_expires_at, refresh_expires_at,
      kind, device_label, created_ip_hash, chain_id, last_used_at
    ) values (
      zh.hash_token(p_new_access), zh.hash_token(p_new_refresh), s.owner_id,
      now() + interval '15 minutes', now() + interval '15 minutes', now() + interval '365 days',
      'web', left(coalesce(p_device_label, s.device_label, ''), 80), s.created_ip_hash, s.chain_id, now()
    );
    select * into o from zh.owners where id = s.owner_id;
    return jsonb_build_object('status', 'issued', 'email', o.email, 'name', o.name);
  end if;
  select * into s from zh.sessions where refresh_hash = zh.hash_token(p_refresh);
  if not found then
    return jsonb_build_object('status', 'invalid', 'hint', 'auth');
  end if;
  if s.grace_cipher is not null and s.grace_expires_at > now() then
    select * into o from zh.owners where id = s.owner_id;
    return jsonb_build_object('status', 'grace', 'cipher', s.grace_cipher, 'email', o.email, 'name', o.name);
  end if;
  if s.rotated_at is not null or s.revoked_at is not null then
    update zh.sessions
       set revoked_at = coalesce(revoked_at, now()), revoke_reason = 'refresh_reuse'
     where chain_id = s.chain_id;
    insert into zh.auth_events (owner_id, kind, ip_hash, device_label)
    values (s.owner_id, 'refresh_reuse', s.created_ip_hash, s.device_label);
    return jsonb_build_object('status', 'reuse', 'hint', 'revoked');
  end if;
  return jsonb_build_object('status', 'invalid', 'hint', 'auth');
end $$;

-- ---------------------------------------------------------------------------
-- Telegram-сессии. Вызов только у service_role, даже с верным p_secret.
-- ---------------------------------------------------------------------------

create or replace function public.zh_tg_session(
  p_tg_user_id bigint, p_device_key text, p_device_label text, p_ip_hash text,
  p_username text, p_first_name text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  l zh.tg_links;
  o zh.owners;
  t text;
  n int;
  v_key text := coalesce(nullif(p_device_key, ''), 'none');
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  select * into l from zh.tg_links where tg_user_id = p_tg_user_id;
  if not found then
    return jsonb_build_object('need_link', true, 'tg', jsonb_build_object('first_name', left(coalesce(p_first_name, ''), 80)));
  end if;
  select * into o from zh.owners where id = l.owner_id;
  if o.disabled_at is not null then
    return jsonb_build_object('error', 'Аккаунт отключён', 'hint', 'disabled');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(l.owner_id::text, 1));
  update zh.sessions
     set revoked_at = now(), revoke_reason = 'rotated', expires_at = least(expires_at, now())
   where owner_id = l.owner_id and kind = 'tg' and tg_user_id = p_tg_user_id
     and device_key = v_key and revoked_at is null;
  select count(*) into n from zh.sessions
   where owner_id = l.owner_id and kind = 'tg' and revoked_at is null
     and expires_at > now() and (abs_expires_at is null or abs_expires_at > now());
  while n >= 5 loop
    update zh.sessions
       set revoked_at = now(), revoke_reason = 'rotated', expires_at = least(expires_at, now())
     where token_hash = (
       select token_hash from zh.sessions
        where owner_id = l.owner_id and kind = 'tg' and revoked_at is null
          and expires_at > now() and (abs_expires_at is null or abs_expires_at > now())
        order by last_used_at asc, created_at asc
        limit 1
     );
    n := n - 1;
  end loop;
  t := zh.new_token();
  insert into zh.sessions (
    token_hash, owner_id, expires_at, abs_expires_at, kind, tg_user_id,
    device_key, device_label, created_ip_hash, last_used_at
  ) values (
    zh.hash_token(t), l.owner_id, now() + interval '7 days', now() + interval '30 days', 'tg', p_tg_user_id,
    v_key, left(coalesce(p_device_label, ''), 80), p_ip_hash, now()
  );
  update zh.tg_links
     set last_seen_at = now(),
         tg_username = coalesce(nullif(p_username, ''), tg_username),
         tg_first_name = coalesce(nullif(p_first_name, ''), tg_first_name)
   where tg_user_id = p_tg_user_id;
  insert into zh.auth_events (owner_id, kind, tg_user_id, ip_hash, device_label)
  values (l.owner_id, 'login_ok', p_tg_user_id, p_ip_hash, left(coalesce(p_device_label, ''), 80));
  return jsonb_build_object('token', t, 'email', o.email, 'name', o.name);
end $$;

create or replace function zh.burn_initdata(p_hash text) returns boolean
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare v text;
begin
  insert into zh.tg_initdata_used (hash_sha256, expires_at)
  values (p_hash, now() + interval '1 hour 1 minute')
  on conflict do nothing
  returning hash_sha256 into v;
  return v is not null;
end $$;

revoke all on function zh.burn_initdata(text) from public, anon, authenticated;

create or replace function zh.bind_tg(
  p_owner uuid, p_tg_user_id bigint, p_username text, p_first_name text,
  p_version text, p_device_key text, p_device_label text, p_ip_hash text
) returns jsonb
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare t text; o zh.owners; v_key text := coalesce(nullif(p_device_key, ''), 'none');
begin
  if exists (select 1 from zh.tg_links where tg_user_id = p_tg_user_id and owner_id <> p_owner) then
    return jsonb_build_object('error', 'Этот Telegram уже привязан к другому аккаунту. Сначала отвяжите его там', 'hint', 'taken');
  end if;
  if exists (select 1 from zh.tg_links where owner_id = p_owner and tg_user_id <> p_tg_user_id) then
    return jsonb_build_object('error', 'К этому аккаунту уже привязан другой Telegram', 'hint', 'taken');
  end if;
  update zh.sessions
     set revoked_at = now(), revoke_reason = 'rotated', expires_at = least(expires_at, now())
   where owner_id = p_owner and kind = 'tg' and tg_user_id = p_tg_user_id
     and device_key = v_key and revoked_at is null;
  insert into zh.tg_links (tg_user_id, owner_id, tg_username, tg_first_name)
  values (p_tg_user_id, p_owner, nullif(left(coalesce(p_username, ''), 64), ''), nullif(left(coalesce(p_first_name, ''), 80), ''))
  on conflict (tg_user_id) do update
    set tg_username = excluded.tg_username,
        tg_first_name = excluded.tg_first_name,
        last_seen_at = now()
   where zh.tg_links.owner_id = excluded.owner_id;
  if not exists (select 1 from zh.tg_links where tg_user_id = p_tg_user_id and owner_id = p_owner) then
    return jsonb_build_object('error', 'Этот Telegram уже привязан к другому аккаунту. Сначала отвяжите его там', 'hint', 'taken');
  end if;
  insert into zh.consents (owner_id, kind, version, tg_user_id)
  values (p_owner, 'tg_login', left(coalesce(p_version, ''), 40), p_tg_user_id);
  t := zh.new_token();
  insert into zh.sessions (
    token_hash, owner_id, expires_at, abs_expires_at, kind, tg_user_id,
    device_key, device_label, created_ip_hash, last_used_at
  ) values (
    zh.hash_token(t), p_owner, now() + interval '7 days', now() + interval '30 days', 'tg', p_tg_user_id,
    v_key, left(coalesce(p_device_label, ''), 80), p_ip_hash, now()
  );
  select * into o from zh.owners where id = p_owner;
  insert into zh.auth_events (owner_id, kind, tg_user_id, ip_hash, device_label)
  values (p_owner, 'tg_link', p_tg_user_id, p_ip_hash, left(coalesce(p_device_label, ''), 80));
  return jsonb_build_object('token', t, 'email', o.email, 'name', o.name);
end $$;

revoke all on function zh.bind_tg(uuid, bigint, text, text, text, text, text, text) from public, anon, authenticated;

create or replace function public.zh_link_code_consume(p_code text, p_secret text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  if p_code is null or p_code ~ '^[a-f0-9]{18}$' then
    return jsonb_build_object('error', 'Код не подошёл', 'hint', 'code');
  end if;
  update zh.tg_link_codes
     set used_at = now()
   where code_hash = zh.hash_token(p_code)
     and used_at is null
     and expires_at > now()
  returning owner_id into v;
  if v is null then
    return jsonb_build_object('error', 'Код не подошёл', 'hint', 'code');
  end if;
  return jsonb_build_object('owner_id', v);
end $$;

create or replace function public.zh_tg_link(
  p_init_hash text, p_tg_user_id bigint, p_username text, p_first_name text,
  p_code text, p_consent boolean, p_consent_version text,
  p_device_key text, p_device_label text, p_ip_hash text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare consumed jsonb; v_owner uuid; bound jsonb;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  if p_consent is not true then
    return jsonb_build_object('error', 'Нужно согласие на обработку Telegram ID, имени и username', 'hint', 'consent');
  end if;
  if p_tg_user_id is not null and zh.attempt_count('link', null, null, p_tg_user_id, interval '15 minutes') >= 10 then
    return jsonb_build_object('error', zh.rate_msg(zh.wait_minutes('link', null, null, p_tg_user_id, interval '15 minutes')), 'hint', 'rate');
  end if;
  if p_ip_hash is not null and zh.attempt_count('link', null, p_ip_hash, null, interval '15 minutes') >= 30 then
    return jsonb_build_object('error', zh.rate_msg(zh.wait_minutes('link', null, p_ip_hash, null, interval '15 minutes')), 'hint', 'rate');
  end if;
  if exists (select 1 from zh.tg_initdata_used where hash_sha256 = p_init_hash) then
    return jsonb_build_object('error', 'REPLAY', 'hint', 'replay');
  end if;
  consumed := public.zh_link_code_consume(p_code, p_secret);
  if consumed ? 'error' then
    insert into zh.login_attempts (email, ip_hash, kind, tg_user_id) values ('', p_ip_hash, 'link', p_tg_user_id);
    return consumed;
  end if;
  if not zh.burn_initdata(p_init_hash) then
    raise exception 'REPLAY' using hint = 'replay';
  end if;
  v_owner := (consumed->>'owner_id')::uuid;
  bound := zh.bind_tg(v_owner, p_tg_user_id, p_username, p_first_name, p_consent_version, p_device_key, p_device_label, p_ip_hash);
  if bound ? 'error' then
    raise exception '%', bound->>'error' using hint = coalesce(bound->>'hint', 'taken');
  end if;
  return bound;
end $$;

create or replace function public.zh_tg_login(
  p_init_hash text, p_tg_user_id bigint, p_username text, p_first_name text,
  p_email text, p_password text, p_consent boolean, p_consent_version text,
  p_device_key text, p_device_label text, p_ip_hash text, p_secret text
) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare a jsonb; bound jsonb;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  if p_consent is not true then
    return jsonb_build_object('error', 'Нужно согласие на обработку Telegram ID, имени и username', 'hint', 'consent');
  end if;
  if exists (select 1 from zh.tg_initdata_used where hash_sha256 = p_init_hash) then
    return jsonb_build_object('error', 'REPLAY', 'hint', 'replay');
  end if;
  a := zh.authenticate(p_email, p_password, p_ip_hash);
  if a ? 'error' then
    return a;
  end if;
  if not zh.burn_initdata(p_init_hash) then
    return jsonb_build_object('error', 'REPLAY', 'hint', 'replay');
  end if;
  bound := zh.bind_tg((a->>'id')::uuid, p_tg_user_id, p_username, p_first_name, p_consent_version, p_device_key, p_device_label, p_ip_hash);
  if bound ? 'error' then
    raise exception '%', bound->>'error' using hint = coalesce(bound->>'hint', 'taken');
  end if;
  return bound;
end $$;

create or replace function public.zh_rate_allow(p_kind text, p_ip_hash text, p_limit int, p_window_sec int, p_secret text)
returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare n int; w interval;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'auth');
  end if;
  w := make_interval(secs => greatest(p_window_sec, 1));
  if p_ip_hash is null then
    return jsonb_build_object('ok', true);
  end if;
  n := zh.attempt_count(p_kind, null, p_ip_hash, null, w);
  if n >= p_limit then
    return jsonb_build_object('error', zh.rate_msg(zh.wait_minutes(p_kind, null, p_ip_hash, null, w)), 'hint', 'rate');
  end if;
  insert into zh.login_attempts (email, ip_hash, kind) values ('', p_ip_hash, p_kind);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- привязка с сайта, устройства, пароль, выход
-- ---------------------------------------------------------------------------

create or replace function public.zh_link_code_issue(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  v uuid := zh.owner_id(p_token);
  n int;
  raw bytea := extensions.gen_random_bytes(16);
  code text;
begin
  perform zh.session_touch(p_token);
  select count(*) into n from zh.tg_link_codes
   where owner_id = v and created_at > now() - interval '1 hour';
  if n >= 5 then
    return jsonb_build_object('error', 'Слишком много кодов, подождите час', 'hint', 'rate');
  end if;
  code := translate(rtrim(encode(raw, 'base64'), '='), '+/', '-_');
  insert into zh.tg_link_codes (code_hash, owner_id, expires_at)
  values (zh.hash_token(code), v, now() + interval '10 minutes');
  insert into zh.auth_events (owner_id, kind) values (v, 'link_code_issued');
  return jsonb_build_object('code', code, 'expires_at', now() + interval '10 minutes');
end $$;

create or replace function public.zh_link_status(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid := zh.owner_id(p_token); c zh.tg_link_codes; l zh.tg_links;
begin
  select * into c from zh.tg_link_codes where code_hash = zh.hash_token(coalesce(p_code, '')) and owner_id = v;
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  if c.used_at is null and c.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;
  if c.used_at is null then
    return jsonb_build_object('status', 'pending');
  end if;
  select * into l from zh.tg_links where owner_id = v;
  return jsonb_build_object('status', 'linked', 'username', l.tg_username, 'first_name', l.tg_first_name, 'bound_at', l.bound_at);
end $$;

create or replace function zh.unbind_owner(p_owner uuid, p_kind text, p_reason text) returns void
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare l zh.tg_links;
begin
  select * into l from zh.tg_links where owner_id = p_owner;
  update zh.sessions
     set revoked_at = coalesce(revoked_at, now()),
         revoke_reason = p_reason,
         expires_at = least(expires_at, now())
   where owner_id = p_owner and kind = 'tg' and revoked_at is null;
  delete from zh.tg_links where owner_id = p_owner;
  update zh.consents set withdrawn_at = now()
   where owner_id = p_owner and kind = 'tg_login' and withdrawn_at is null;
  insert into zh.auth_events (owner_id, kind, tg_user_id)
  values (p_owner, p_kind, l.tg_user_id);
end $$;

revoke all on function zh.unbind_owner(uuid, text, text) from public, anon, authenticated;

create or replace function public.zh_tg_unbind(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid := zh.owner_id(p_token);
begin
  perform zh.unbind_owner(v, 'tg_unlink', 'unbind');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.zh_link_dispute(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid := zh.owner_id(p_token);
begin
  perform zh.unbind_owner(v, 'tg_unlink_disputed', 'unbind');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.zh_devices(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid := zh.owner_id(p_token); h text := zh.hash_token(p_token); l zh.tg_links;
begin
  perform zh.session_touch(p_token);
  select * into l from zh.tg_links where owner_id = v;
  return jsonb_build_object(
    'tg', case when l.tg_user_id is null then null else jsonb_build_object(
      'username', l.tg_username, 'first_name', l.tg_first_name, 'bound_at', l.bound_at) end,
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id, 'kind', s.kind, 'label', s.device_label,
        'created_at', s.created_at, 'last_used_at', s.last_used_at,
        'current', s.token_hash = h
      ) order by s.last_used_at desc)
      from zh.sessions s
      where s.owner_id = v and s.revoked_at is null
        and (
          (s.kind = 'tg' and s.expires_at > now() and (s.abs_expires_at is null or s.abs_expires_at > now()))
          or (s.kind = 'web' and s.refresh_expires_at > now())
        )
    ), '[]'::jsonb));
end $$;

create or replace function public.zh_device_end(p_token text, p_id uuid) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid := zh.owner_id(p_token); s zh.sessions;
begin
  select * into s from zh.sessions
   where id = p_id and owner_id = v and revoked_at is null;
  if not found then
    return jsonb_build_object('error', 'Устройство не найдено', 'hint', 'missing');
  end if;
  update zh.sessions
     set revoked_at = now(), revoke_reason = 'device_end', expires_at = least(expires_at, now())
   where id = s.id;
  if s.kind = 'tg' then
    delete from zh.tg_links where owner_id = v;
    update zh.consents set withdrawn_at = now()
     where owner_id = v and kind = 'tg_login' and withdrawn_at is null;
  end if;
  insert into zh.auth_events (owner_id, kind, tg_user_id, device_label)
  values (v, 'device_end', s.tg_user_id, s.device_label);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.zh_logout_all(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid := zh.owner_id(p_token);
begin
  update zh.sessions
     set revoked_at = coalesce(revoked_at, now()),
         revoke_reason = case when revoked_at is null then 'logout_all' else revoke_reason end,
         expires_at = least(expires_at, now())
   where owner_id = v and revoked_at is null;
  perform zh.unbind_owner(v, 'logout_all', 'logout_all');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.zh_password(p_token text, p_current text, p_new text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  v uuid := zh.owner_id(p_token);
  o zh.owners;
  s zh.sessions;
begin
  select * into s from zh.sessions where token_hash = zh.hash_token(p_token);
  select * into o from zh.owners where id = v for update;
  if o.pass_hash <> extensions.crypt(coalesce(p_current, ''), o.pass_hash) then
    return jsonb_build_object('error', 'Неверный текущий пароль', 'hint', 'auth');
  end if;
  if length(coalesce(p_new, '')) < 8 or length(p_new) > 72 then
    return jsonb_build_object('error', 'Пароль — от 8 до 72 символов', 'hint', 'invalid');
  end if;
  update zh.owners
     set pass_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10))
   where id = v;
  update zh.sessions
     set revoked_at = now(), revoke_reason = 'password', expires_at = least(expires_at, now())
   where owner_id = v and revoked_at is null and token_hash <> zh.hash_token(p_token);
  if s.kind is distinct from 'tg' then
    delete from zh.tg_links where owner_id = v;
    update zh.consents set withdrawn_at = now()
     where owner_id = v and kind = 'tg_login' and withdrawn_at is null;
  end if;
  insert into zh.auth_events (owner_id, kind, tg_user_id, device_label)
  values (v, 'password_change', s.tg_user_id, s.device_label);
  return jsonb_build_object('ok', true);
end $$;

create or replace function zh.issue_owner_invite(p_owner uuid) returns jsonb
language plpgsql volatile security definer set search_path to pg_catalog as $$
declare n int; code text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  select count(*) into n from zh.owner_invites
   where created_by = p_owner and created_at > now() - interval '1 day';
  if n >= 20 then
    return jsonb_build_object('error', 'Слишком много приглашений, подождите сутки', 'hint', 'rate');
  end if;
  insert into zh.owner_invites (code_hash, created_by, expires_at, role)
  values (zh.hash_token(code), p_owner, now() + interval '7 days', 'owner');
  return jsonb_build_object('code', code, 'expires_at', now() + interval '7 days', 'role', 'owner');
end $$;

revoke all on function zh.issue_owner_invite(uuid) from public, anon, authenticated;

create or replace function public.zh_invite_issue(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  v uuid := zh.owner_id(p_token);
  s zh.sessions;
  o zh.owners;
begin
  select * into s from zh.sessions where token_hash = zh.hash_token(p_token);
  if s.kind is distinct from 'web' then
    return jsonb_build_object('error', 'Приглашение выдаётся только из сессии сайта', 'hint', 'forbidden');
  end if;
  select * into o from zh.owners where id = v;
  if o.platform_admin is not true then
    return jsonb_build_object('error', 'Приглашения выдаёт только администратор платформы', 'hint', 'forbidden');
  end if;
  return zh.issue_owner_invite(v);
end $$;

create or replace function public.zh_invite_issue_admin(p_token text, p_admin_ids text, p_secret text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  v uuid;
  s zh.sessions;
  o zh.owners;
  tg bigint;
  allowed boolean := false;
  piece text;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('error', 'forbidden', 'hint', 'forbidden');
  end if;
  v := zh.owner_id(p_token);
  select * into s from zh.sessions where token_hash = zh.hash_token(p_token);
  if s.kind is distinct from 'web' then
    return jsonb_build_object('error', 'Приглашение выдаётся только из сессии сайта', 'hint', 'forbidden');
  end if;
  select * into o from zh.owners where id = v;
  if o.platform_admin then
    allowed := true;
  else
    select l.tg_user_id into tg from zh.tg_links l where l.owner_id = v;
    if tg is not null then
      foreach piece in array string_to_array(replace(coalesce(p_admin_ids, ''), ' ', ''), ',') loop
        if piece <> '' and piece = tg::text then allowed := true; end if;
      end loop;
    end if;
  end if;
  if not allowed then
    return jsonb_build_object('error', 'Приглашения выдаёт только администратор платформы', 'hint', 'forbidden');
  end if;
  return zh.issue_owner_invite(v);
end $$;

create or replace function public.zh_auth_note(p_kind text, p_secret text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare n int;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('ok', false);
  end if;
  insert into zh.auth_alerts (kind) values (left(coalesce(p_kind, '?'), 40));
  select count(*) into n from zh.auth_alerts where at > now() - interval '5 minutes';
  return jsonb_build_object('count', n, 'alert', n > 50);
end $$;

create or replace function public.zh_auth_cleanup(p_secret text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare a int; b int; c int;
begin
  if p_secret is null or length(p_secret) < 16 then
    return jsonb_build_object('ok', false);
  end if;
  delete from zh.tg_initdata_used where expires_at < now();
  get diagnostics a = row_count;
  delete from zh.auth_events where at < now() - interval '1 year';
  get diagnostics b = row_count;
  delete from zh.login_attempts where at < now() - interval '2 days';
  delete from zh.auth_alerts where at < now() - interval '2 days';
  get diagnostics c = row_count;
  return jsonb_build_object('ok', true, 'initdata', a, 'events', b);
end $$;

-- ---------------------------------------------------------------------------
-- права: выдающие сессию функции недоступны anon, даже с верным секретом
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
  who text;
begin
  execute format('grant execute on function zh.session_touch(text) to %I', current_user);
  execute format('grant execute on function zh.burn_initdata(text) to %I', current_user);
  execute format('grant execute on function zh.bind_tg(uuid, bigint, text, text, text, text, text, text) to %I', current_user);
  execute format('grant execute on function zh.authenticate(text, text, text) to %I', current_user);
  execute format('grant execute on function zh.issue_web(uuid, text, text, uuid) to %I', current_user);
  execute format('grant execute on function zh.unbind_owner(uuid, text, text) to %I', current_user);
  execute format('grant execute on function zh.attempt_count(text, text, text, bigint, interval) to %I', current_user);
  execute format('grant execute on function zh.wait_minutes(text, text, text, bigint, interval) to %I', current_user);
  execute format('grant execute on function zh.issue_owner_invite(uuid) to %I', current_user);
  foreach fn in array array[
    'public.zh_tg_session(bigint, text, text, text, text, text, text)',
    'public.zh_tg_link(text, bigint, text, text, text, boolean, text, text, text, text, text)',
    'public.zh_tg_login(text, bigint, text, text, text, text, boolean, text, text, text, text, text)',
    'public.zh_link_code_consume(text, text)',
    'public.zh_web_login(text, text, text, text, text)',
    'public.zh_web_register(text, text, text, text, text, text, text)',
    'public.zh_web_refresh(text, text, text, text, text, text)',
    'public.zh_migrate(text, text, text, text)',
    'public.zh_rate_allow(text, text, int, int, text)',
    'public.zh_auth_note(text, text)',
    'public.zh_auth_cleanup(text)',
    'public.zh_invite_issue_admin(text, text, text)'
  ]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
    execute format('grant execute on function %s to %I', fn, current_user);
  end loop;
end $$;
