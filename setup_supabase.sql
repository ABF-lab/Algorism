-- Supabase Database Setup Script for Sehat Ledger
-- Paste this script into the Supabase SQL Editor (https://supabase.com/dashboard/project/wrzydzgyywwfffjojzko) to initialize the database.

-- 1. Create a table to store clinical records as JSON documents (ideal for offline apps)
create table if not exists records (
  id text primary key,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  data jsonb not null
);

-- Enable Row Level Security (RLS) if desired, or leave open for simple camp use
alter table records enable row level security;

-- Create policy to allow all anonymous access (or authenticated only, depending on setup)
create policy "Allow public read and write" 
on records for all 
using (true) 
with check (true);

-- 2. Create the RPC function that handles merging and conflict resolution
create or replace function sync_records(local_records jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  item jsonb;
  remote_item jsonb;
  res_array jsonb := '[]'::jsonb;
begin
  -- Loop through each local record sent from the PWA client
  for item in select * from jsonb_array_elements(local_records) loop
    -- Locate any existing database record with the same ID
    select data into remote_item from records where id = (item->>'id');
    
    if found then
      -- Conflict Resolution: Keep the record that has the newer updatedAt timestamp
      if (item->>'updatedAt')::timestamptz > (remote_item->>'updatedAt')::timestamptz then
        update records 
        set updated_at = (item->>'updatedAt')::timestamptz,
            data = item
        where id = (item->>'id');
      end if;
    else
      -- If it's a new record, insert it directly
      insert into records (id, updated_at, data)
      values (item->>'id', (item->>'updatedAt')::timestamptz, item);
    end if;
  end loop;

  -- Select and return all consolidated records back to the client
  select jsonb_agg(data) into res_array from records;
  
  return coalesce(res_array, '[]'::jsonb);
end;
$$;
