-- =====================================================================
-- Supabase/Postgres schema (v1). Mirrors the SQLite v6 model with
-- per-user ownership. Idempotent; applied by scripts/migrate-supabase.mjs.
-- *_json columns stay TEXT (engine parity — the app always round-trips a
-- JSON string; jsonb would deserialise to objects and break JSON.parse).
-- Timestamps stay TEXT ISO strings for the same reason.
-- =====================================================================

create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,
  purpose          text,
  fields_json      text not null default '{}',
  onboarding_state text not null default 'new',
  onboarding_json  text not null default '[]',
  created_at       text not null,
  updated_at       text not null
);
create index if not exists profiles_updated on public.profiles(updated_at);

create table if not exists public.study_sessions (
  id          text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  category    text not null default 'subject',
  description text,
  tags_json   text not null default '[]',
  status      text not null default 'active',
  created_at  text not null,
  updated_at  text not null
);
create index if not exists sessions_user on public.study_sessions(user_id);

create table if not exists public.sources (
  id          text primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null,
  title       text not null,
  url         text,
  page_count  integer,
  slide_count integer,
  chunk_count integer not null default 0,
  created_at  text not null,
  session_id  text references public.study_sessions(id) on delete set null,
  tags_json   text not null default '[]',
  org_source  text not null default 'manual',
  manual_override integer not null default 0,
  suggestion_json text,
  license     text,
  origin      text not null default 'upload'
);
create index if not exists sources_user on public.sources(user_id);
create index if not exists sources_session on public.sources(session_id);

create table if not exists public.source_segments (
  source_id  text not null references public.sources(id) on delete cascade,
  seg_index  integer not null,
  location   text not null,
  text       text not null,
  primary key (source_id, seg_index)
);

create table if not exists public.quizzes (
  id             text primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  topic          text not null,
  difficulty     text not null,
  question_count integer not null,
  created_at     text not null,
  answered_at    text,
  session_id     text references public.study_sessions(id) on delete set null
);
create index if not exists quizzes_user on public.quizzes(user_id);
create index if not exists quizzes_session on public.quizzes(session_id);

create table if not exists public.quiz_questions (
  quiz_id           text not null references public.quizzes(id) on delete cascade,
  idx               integer not null,
  text              text not null,
  choices_json      text not null,
  correct_choice_id text not null,
  explanation       text not null default '',
  citations_json    text not null default '[]',
  primary key (quiz_id, idx)
);

create table if not exists public.quiz_attempts (
  quiz_id      text primary key references public.quizzes(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  answers_json text not null,
  correct      integer not null,
  total        integer not null,
  created_at   text not null,
  result_json  text
);

create table if not exists public.learner_topics (
  user_id           uuid not null references public.profiles(id) on delete cascade,
  topic             text not null,
  correct           integer not null default 0,
  total             integer not null default 0,
  difficulty        text not null default 'medium',
  updated_at        text not null,
  last_practiced_at text,
  primary key (user_id, topic)
);

create table if not exists public.decks (
  id               text primary key,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  session_id       text references public.study_sessions(id) on delete set null,
  topic            text not null,
  source_ids_json  text not null default '[]',
  card_count       integer not null default 0,
  created_at       text not null,
  last_reviewed_at text
);
create index if not exists decks_user on public.decks(user_id);
create index if not exists decks_session on public.decks(session_id);

create table if not exists public.deck_cards (
  deck_id        text not null references public.decks(id) on delete cascade,
  idx            integer not null,
  front          text not null,
  back           text not null,
  citations_json text not null default '[]',
  status         text not null default 'new',
  reviewed_at    text,
  primary key (deck_id, idx)
);

create table if not exists public.activity (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       text not null,
  topic      text,
  detail     text not null,
  at         text not null,
  session_id text
);
create index if not exists activity_user on public.activity(user_id, id desc);

create table if not exists public.learner_subjects (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  subject     text not null,
  familiarity text not null,
  confidence  integer,
  source      text not null default 'stated',
  updated_at  text not null,
  primary key (user_id, subject)
);

create table if not exists public.learning_events (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  kind        text not null,
  topic       text,
  detail_json text not null default '{}',
  weight      integer not null default 1,
  at          text not null
);
create index if not exists events_user on public.learning_events(user_id, id desc);

create table if not exists public.vector_chunks (
  id             text primary key,
  user_id        uuid references public.profiles(id) on delete cascade,
  source_id      text,
  text           text not null,
  embedding_json text not null,
  metadata_json  text not null default '{}'
);
create index if not exists vector_chunks_user on public.vector_chunks(user_id);

create table if not exists public.app_meta (
  key   text primary key,
  value text not null
);
-- Global app state (embed-model parity etc.), not user data: RLS ON with
-- NO policy = default-deny for the REST surface; the privileged Node
-- backend basal connection has its own NON-RLS role and reads it fine.
-- (app_meta RLS note: has global values only; users need nothing here.)

alter table public.app_meta enable row level security; -- default-deny for REST
create index if not exists quiz_attempts_user on public.quiz_attempts(user_id);

-- ------------------------------------------------------------------
-- Defense-in-depth RLS: the Node backend connects with a privileged
-- role and enforces ownership in SQL predicates (user_id = verified
-- token id). These policies protect the REST/PostgREST + dashboard
-- surface so no anon/authenticated role can touch private data.
-- ------------------------------------------------------------------
alter table public.profiles        enable row level security;
alter table public.study_sessions  enable row level security;
alter table public.sources         enable row level security;
alter table public.source_segments enable row level security;
alter table public.quizzes         enable row level security;
alter table public.quiz_questions  enable row level security;
alter table public.quiz_attempts   enable row level security;
alter table public.learner_topics  enable row level security;
alter table public.decks           enable row level security;
alter table public.deck_cards      enable row level security;
alter table public.activity        enable row level security;
alter table public.learner_subjects enable row level security;
alter table public.learning_events enable row level security;
alter table public.vector_chunks   enable row level security;

drop policy if exists own_rows on public.profiles;
create policy own_rows on public.profiles for all using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
drop policy if exists own_rows on public.study_sessions;
create policy own_rows on public.study_sessions for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.sources;
create policy own_rows on public.sources for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.quizzes;
create policy own_rows on public.quizzes for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.quiz_attempts;
create policy own_rows on public.quiz_attempts for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.learner_topics;
create policy own_rows on public.learner_topics for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.decks;
create policy own_rows on public.decks for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.activity;
create policy own_rows on public.activity for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.learner_subjects;
create policy own_rows on public.learner_subjects for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists own_rows on public.learning_events;
create policy own_rows on public.learning_events for all using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
