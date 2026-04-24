create extension if not exists vector;

create table if not exists public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_document_id text not null,
  title text not null,
  url text,
  source_path text,
  last_modified_at timestamptz,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_document_id)
);

create table if not exists public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  source text not null,
  source_document_id text not null,
  chunk_index integer not null,
  title text not null,
  body text not null,
  domain text,
  url text,
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists kb_documents_source_document_idx
  on public.kb_documents (source, source_document_id);

create index if not exists kb_chunks_document_idx
  on public.kb_chunks (document_id);

create index if not exists kb_chunks_source_domain_idx
  on public.kb_chunks (source, domain);

create index if not exists kb_chunks_embedding_hnsw_idx
  on public.kb_chunks
  using hnsw (embedding vector_cosine_ops);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists kb_documents_touch_updated_at on public.kb_documents;
create trigger kb_documents_touch_updated_at
before update on public.kb_documents
for each row execute function public.touch_updated_at();

drop trigger if exists kb_chunks_touch_updated_at on public.kb_chunks;
create trigger kb_chunks_touch_updated_at
before update on public.kb_chunks
for each row execute function public.touch_updated_at();

create or replace function public.match_knowledge_chunks(
  query_embedding vector(1536),
  match_count integer default 8,
  match_threshold double precision default 0.68,
  filter_source text default null,
  filter_domain text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  source text,
  source_document_id text,
  chunk_index integer,
  title text,
  body text,
  domain text,
  url text,
  similarity double precision
)
language sql
stable
as $$
  select
    kb_chunks.id as chunk_id,
    kb_chunks.document_id,
    kb_chunks.source,
    kb_chunks.source_document_id,
    kb_chunks.chunk_index,
    kb_chunks.title,
    kb_chunks.body,
    kb_chunks.domain,
    kb_chunks.url,
    1 - (kb_chunks.embedding <=> query_embedding) as similarity
  from public.kb_chunks
  where
    (filter_source is null or kb_chunks.source = filter_source)
    and (filter_domain is null or kb_chunks.domain = filter_domain)
    and 1 - (kb_chunks.embedding <=> query_embedding) >= match_threshold
  order by kb_chunks.embedding <=> query_embedding
  limit least(match_count, 50);
$$;
