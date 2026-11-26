-- Минимальная схема Журналки для локальных тестов (Postgres 17).
-- Это НЕ прод и НЕ то, что применяют к Supabase. Сначала этот файл, затем sql/20261126_tg_auth.sql.
-- Роли anon / authenticated / service_role нужны, чтобы проверить revoke/grant как у PostgREST.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists zh;
grant usage on schema zh to anon, authenticated, service_role;

create table if not exists zh.owners (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  pass_hash text not null,
  name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists zh.sessions (
  token_hash text primary key,
  owner_id uuid not null references zh.owners (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists zh.login_attempts (
  id bigserial primary key,
  email text not null,
  at timestamptz not null default now()
);

create table if not exists zh.tg (
  owner_id uuid primary key references zh.owners (id),
  code text,
  chat_id bigint,
  chat_title text not null default '',
  bound_at timestamptz
);

create table if not exists zh.points (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references zh.owners (id),
  name text not null default '',
  address text not null default '',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create or replace function zh.clean(p text, n int) returns text
language sql immutable set search_path to pg_catalog as $$
  select left(trim(coalesce(p, '')), n)
$$;

create or replace function zh.today_status(p_point uuid) returns jsonb
language sql stable set search_path to pg_catalog as $$
  select jsonb_build_object(
    'alerts', 0, 'journals', '[]'::jsonb, 'units', '[]'::jsonb,
    'health_done', 0, 'staff', 0, 'health_wait', 0, 'health_off', 0,
    'med_soon', '[]'::jsonb, 'med_missing', 0, 'counts', '{}'::jsonb, 'day', current_date)
$$;

-- Текущие функции прода (сняты чтением 26.11.2026). Миграция заменяет owner_id, login, logout, me, register.

create or replace function zh.hash_token(p text) returns text
language sql immutable set search_path to pg_catalog as $$
  select encode(extensions.digest(convert_to(coalesce(p, ''), 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function zh.new_token() returns text
language sql set search_path to pg_catalog as $$
  select encode(extensions.gen_random_bytes(24), 'hex')
$$;

create or replace function zh.owner_id(p_token text) returns uuid
language plpgsql stable set search_path to pg_catalog as $$
declare v uuid;
begin
  if p_token is null or length(p_token) < 20 then
    raise exception 'Нужно войти' using hint = 'auth';
  end if;
  select s.owner_id into v from zh.sessions s
   where s.token_hash = zh.hash_token(p_token) and s.expires_at > now();
  if v is null then
    raise exception 'Сессия закончилась, войдите снова' using hint = 'auth';
  end if;
  return v;
end $$;

create or replace function public.zh_login(p_email text, p_password text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  o zh.owners;
  t text;
  n int;
begin
  select count(*) into n from zh.login_attempts where email = e and at > now() - interval '15 minutes';
  if n >= 10 then
    return jsonb_build_object('error', 'Слишком много попыток. Подождите 15 минут');
  end if;
  select * into o from zh.owners where email = e;
  if not found or o.pass_hash <> extensions.crypt(coalesce(p_password, ''), o.pass_hash) then
    insert into zh.login_attempts (email) values (e);
    return jsonb_build_object('error', 'Неверная почта или пароль');
  end if;
  t := zh.new_token();
  insert into zh.sessions (token_hash, owner_id, expires_at) values (zh.hash_token(t), o.id, now() + interval '30 days');
  return jsonb_build_object('token', t, 'email', o.email, 'name', o.name);
end $$;

create or replace function public.zh_logout(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin
  update zh.sessions set expires_at = now() where token_hash = zh.hash_token(p_token);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.zh_me(p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v_owner uuid := zh.owner_id(p_token); o zh.owners;
begin
  select * into o from zh.owners where id = v_owner;
  return jsonb_build_object('email', o.email, 'name', o.name,
    'points', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'address', p.address,
        'status', zh.today_status(p.id)) order by p.created_at)
      from zh.points p where p.owner_id = v_owner and p.active), '[]'::jsonb));
end $$;

create or replace function public.zh_register(p_email text, p_password text, p_name text default '') returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare
  e text := lower(trim(coalesce(p_email, '')));
  o zh.owners;
  t text;
begin
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(e) > 200 then
    raise exception 'Проверьте адрес почты' using hint = 'invalid';
  end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then
    raise exception 'Пароль — от 8 до 72 символов' using hint = 'invalid';
  end if;
  if exists (select 1 from zh.owners where email = e) then
    raise exception 'Эта почта уже зарегистрирована — войдите' using hint = 'exists';
  end if;
  if (select count(*) from zh.owners where created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Слишком много регистраций, попробуйте через час' using hint = 'rate';
  end if;
  insert into zh.owners (email, pass_hash, name)
  values (e, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), zh.clean(p_name, 80))
  returning * into o;
  t := zh.new_token();
  insert into zh.sessions (token_hash, owner_id, expires_at) values (zh.hash_token(t), o.id, now() + interval '30 days');
  return jsonb_build_object('token', t, 'email', o.email, 'name', o.name);
end $$;

-- Заглушки RPC кабинета: на проде они уже есть и зовут zh.owner_id.
-- Здесь они нужны, чтобы тест погашенной сессии прошёлся по каждому имени.
-- В миграцию прода их не кладём.

create or replace function public.zh_point_get(p_token text, p_point uuid default null) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_point_create(p_token text, p_name text default '', p_address text default '', p_org text default '') returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_point_update(p_token text, p_point uuid default null, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_point_archive(p_token text, p_point uuid default null) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_entries(p_token text, p_point uuid default null, p_journal text default '', p_from date default null, p_to date default null) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_entry_void(p_token text, p_point uuid default null, p_entry uuid default null, p_reason text default '') returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_owner_entry(p_token text, p_point uuid default null, p_journal text default '', p_unit uuid default null, p_data jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_admit(p_token text, p_point uuid default null, p_entry uuid default null, p_admitted boolean default false) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_invite_new(p_token text, p_point uuid default null) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_staff_link(p_token text, p_point uuid default null, p_staff uuid default null) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_staff_update(p_token text, p_point uuid default null, p_staff uuid default null, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_unit_remove(p_token text, p_point uuid default null, p_unit uuid default null) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_unit_save(p_token text, p_point uuid default null, p_unit jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

create or replace function public.zh_agent(p_token text, p_op text default '', p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin perform zh.owner_id(p_token); return jsonb_build_object('ok', true); end $$;

-- Биллинг: на проде bill.owner_of уже вызывает zh.owner_id. Здесь — та же связка для теста.
create schema if not exists bill;
create or replace function bill.owner_of(p_product text, p_token text) returns uuid
language plpgsql stable security definer set search_path to pg_catalog as $$
begin
  return case p_product
    when 'zh' then zh.owner_id(p_token)
    else null
  end;
end $$;

create or replace function public.bill_status(p_product text, p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid;
begin
  v := bill.owner_of(p_product, p_token);
  return jsonb_build_object('ok', true, 'owner', v);
end $$;

create or replace function public.bill_invoices(p_product text, p_token text) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
declare v uuid;
begin
  v := bill.owner_of(p_product, p_token);
  return jsonb_build_object('ok', true, 'owner', v);
end $$;

-- Заглушка системного RPC бота, чтобы вебхук в тестах не ходил в сеть.
create table if not exists zh.agent_sys_calls (
  id bigserial primary key,
  op text,
  args jsonb,
  at timestamptz not null default now()
);

create or replace function public.zh_agent_sys(p_secret text, p_owner uuid, p_op text, p_args jsonb) returns jsonb
language plpgsql security definer set search_path to pg_catalog as $$
begin
  insert into zh.agent_sys_calls (op, args) values (p_op, p_args);
  if p_op = 'tg_bind' then return jsonb_build_object('ok', false); end if;
  if p_op = 'tg_owner' then return jsonb_build_object('owner_id', null); end if;
  if p_op = 'jobs' then return '[]'::jsonb; end if;
  return jsonb_build_object('ok', true);
end $$;

grant execute on all functions in schema public to anon, authenticated, service_role;
grant execute on all functions in schema zh to anon, authenticated, service_role;
grant execute on all functions in schema bill to anon, authenticated, service_role;
