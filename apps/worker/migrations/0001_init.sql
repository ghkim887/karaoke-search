CREATE TABLE IF NOT EXISTS songs (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, source_url TEXT NOT NULL, title_primary TEXT NOT NULL, title_ko TEXT, artist_primary TEXT NOT NULL, artist_ko TEXT, artist_aliases_present INTEGER NOT NULL DEFAULT 0 CHECK (artist_aliases_present IN (0, 1)), crawled_at TEXT NOT NULL, media_context_ko TEXT, title_ko_source TEXT, title_ko_confidence TEXT);
CREATE TABLE IF NOT EXISTS karaoke_numbers (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, provider TEXT NOT NULL CHECK (provider IN ('tj', 'ky', 'joysound')), number TEXT, PRIMARY KEY (song_id, provider));
CREATE TABLE IF NOT EXISTS song_categories (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, category TEXT NOT NULL CHECK (category IN ('jpop', 'vocaloid', 'anime')), PRIMARY KEY (song_id, position));
CREATE TABLE IF NOT EXISTS artist_aliases (song_id TEXT NOT NULL REFERENCES songs(id) ON DELETE CASCADE, position INTEGER NOT NULL, alias TEXT NOT NULL, PRIMARY KEY (song_id, position));
CREATE INDEX IF NOT EXISTS idx_songs_sort_order ON songs(sort_order, id);
CREATE INDEX IF NOT EXISTS idx_karaoke_numbers_provider_number ON karaoke_numbers(provider, number) WHERE number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_song_categories_category ON song_categories(category);
