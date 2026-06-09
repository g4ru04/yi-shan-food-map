-- ============================================================
--  阿珊的美食地圖 - Supabase 資料表
--  使用方式：到 Supabase 後台 → SQL Editor → 貼上整段 → Run
-- ============================================================

create table if not exists public.places (
  id            bigint generated always as identity primary key,  -- 自增 id
  created_at    timestamptz not null default now(),               -- 建立時間
  name          text        not null,                             -- 店家名稱
  lat           double precision not null,                        -- 緯度
  lon           double precision not null,                        -- 經度
  review        text        check (char_length(review) <= 500),   -- 文字評價（500 字內）
  rating        numeric(2,1) check (rating >= 0 and rating <= 5), -- 我的星等 0~5
  google_rating numeric(2,1) check (google_rating >= 1 and google_rating <= 5), -- Google 星等 1~5
  google_url    text,                                             -- Google 連結 或 place_id
  author        text                                              -- 建立者（上傳當下的使用者名稱）
);

-- 若資料表已存在但缺 author 欄位，補上（已存在則無動作）
alter table public.places add column if not exists author text;

-- 依時間排序常用，加個索引
create index if not exists places_created_at_idx on public.places (created_at desc);

-- ---- Row Level Security（RLS）----
-- 開啟 RLS，並開放匿名金鑰可讀寫（個人專案 / 給朋友共用用）。
-- ⚠️ 注意：這代表「任何拿到網址的人都能新增/修改/刪除」。
--    若只想自己能寫、別人只能看，請見 README 的「鎖定寫入」說明。
alter table public.places enable row level security;

drop policy if exists "public read"   on public.places;
drop policy if exists "public insert" on public.places;
drop policy if exists "public update" on public.places;
drop policy if exists "public delete" on public.places;

create policy "public read"   on public.places for select using (true);
create policy "public insert" on public.places for insert with check (true);
create policy "public update" on public.places for update using (true) with check (true);
create policy "public delete" on public.places for delete using (true);
