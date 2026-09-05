create table if not exists public.registrations (
  id text primary key,
  full_name text not null,
  phone text not null,
  college text not null,
  major_ar text not null,
  major_en text not null,
  year text not null check (year in ('3', '4', 'final')),
  year_label_ar text,
  year_label_en text,
  section_ar text not null,
  section_en text not null,
  submitted_at timestamptz not null default now()
);

alter table public.registrations enable row level security;

-- No public policies are needed. The browser talks to server.js, and only the
-- server uses the Supabase service-role key. Never expose that key in the HTML.

create index if not exists registrations_submitted_at_idx
  on public.registrations (submitted_at desc);

-- Run this migration on existing databases to admit juniors.
alter table public.registrations drop constraint if exists registrations_year_check;
alter table public.registrations add constraint registrations_year_check
  check (year = 'final' or
    (college = 'engineering' and major_en = 'Architecture Program' and year = '4') or
    (not (college = 'engineering' and major_en = 'Architecture Program') and year = '3'));
