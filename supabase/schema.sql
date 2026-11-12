-- ============================================================
--  Nasdaq & S&P 500 News Bot - esquema de base de datos
--  Pégalo ENTERO en Supabase -> SQL Editor -> New query -> Run.
--  Es seguro ejecutarlo más de una vez (usa IF NOT EXISTS).
-- ============================================================

create extension if not exists pgcrypto;

-- Mantiene updated_at al día
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ------------------------------------------------------------
-- Noticias procesadas. url_hash UNIQUE evita duplicados incluso
-- si dos ejecuciones coinciden: solo una consigue insertar la fila.
-- ------------------------------------------------------------
create table if not exists news_items (
  id               uuid primary key default gen_random_uuid(),
  url_hash         text not null unique,
  url              text not null,
  title            text not null,
  title_key        text not null default '',
  summary          text not null default '',
  source           text not null default '',
  published_at     timestamptz,
  relevance_score  integer not null default 0,
  status           text not null default 'processing'
                   check (status in ('skipped','processing','analyzed','published','archived','failed')),
  impact           text check (impact in ('ALTO','MEDIO','BAJO')),
  analysis         jsonb,
  error            text,
  discord_message_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists news_items_created_idx on news_items (created_at desc);
create index if not exists news_items_status_idx  on news_items (status, created_at);
drop trigger if exists news_items_updated on news_items;
create trigger news_items_updated before update on news_items
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- Historial de publicaciones en Discord
-- ------------------------------------------------------------
create table if not exists publications (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,            -- news | summary | calendar_alert
  ref_id      text,
  channel_id  text not null,
  discord_message_id text not null,
  posted_at   timestamptz not null default now()
);
create index if not exists publications_posted_idx on publications (posted_at desc);

-- ------------------------------------------------------------
-- Resúmenes horarios. bucket UNIQUE = un solo resumen por hora.
-- ------------------------------------------------------------
create table if not exists hourly_summaries (
  bucket      timestamptz primary key,
  summary     jsonb,
  discord_message_id text,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Eventos del calendario económico
-- ------------------------------------------------------------
create table if not exists economic_events (
  id          text primary key,
  title       text not null,
  category    text,
  event_time  timestamptz not null,
  country     text not null default 'USD',
  impact      text not null check (impact in ('ALTO','MEDIO','BAJO')),
  forecast    text,
  previous    text,
  actual      text,
  alert_sent  boolean not null default false,
  alerted_at  timestamptz,
  updated_at  timestamptz not null default now()
);
create index if not exists economic_events_time_idx on economic_events (event_time);
drop trigger if exists economic_events_updated on economic_events;
create trigger economic_events_updated before update on economic_events
  for each row execute function set_updated_at();

-- ------------------------------------------------------------
-- Control de ejecuciones (bloqueo): (job, bucket) UNIQUE.
-- Si GitHub lanza dos veces la misma ventana, solo una continúa.
-- ------------------------------------------------------------
create table if not exists job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null,
  bucket      text not null,
  status      text not null default 'running',   -- running | ok | error
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  stats       jsonb,
  error       text,
  unique (job, bucket)
);
create index if not exists job_runs_started_idx on job_runs (started_at desc);

-- ------------------------------------------------------------
-- Consumo de Claude (para los límites diarios)
-- ------------------------------------------------------------
create table if not exists claude_usage (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,                   -- news | summary | manual
  model         text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists claude_usage_created_idx on claude_usage (created_at desc);

-- ------------------------------------------------------------
-- Pares clave/valor (esperas entre comandos, estado de las fuentes...)
-- ------------------------------------------------------------
create table if not exists kv (
  key         text primary key,
  value       jsonb,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- SEGURIDAD: activamos RLS sin ninguna política.
-- Resultado: la clave pública ("anon") NO puede leer ni escribir nada.
-- Solo el servidor con la clave service_role (que se salta RLS) accede.
-- ------------------------------------------------------------
alter table news_items       enable row level security;
alter table publications     enable row level security;
alter table hourly_summaries enable row level security;
alter table economic_events  enable row level security;
alter table job_runs         enable row level security;
alter table claude_usage     enable row level security;
alter table kv               enable row level security;

-- ------------------------------------------------------------
-- Limpieza opcional (ejecútala a mano de vez en cuando para no llenar
-- el plan gratuito): borra datos con más de 60 días.
-- ------------------------------------------------------------
-- delete from news_items   where created_at < now() - interval '60 days';
-- delete from job_runs     where started_at < now() - interval '30 days';
-- delete from claude_usage where created_at < now() - interval '90 days';
-- delete from publications where posted_at  < now() - interval '90 days';
