-- Пациенты, вставшие на учёт. Только то, что нужно для рассылки.
CREATE TABLE IF NOT EXISTS patients (
  id      INTEGER PRIMARY KEY,   -- Telegram ID
  track   TEXT NOT NULL,         -- id назначенного трека (как в CONTENT.tracks)
  form    TEXT,                  -- код формы, например СДПН-03
  card    TEXT,                  -- номер карты, например СДПН-428
  created INTEGER NOT NULL,      -- когда встал на учёт (мс)
  active  INTEGER NOT NULL DEFAULT 1, -- 0 = снят с учёта (/stop или заблокировал бота)
  tracks  TEXT                   -- все треки по всем обследованиям, через запятую (для релизного сообщения)
);
-- Для базы, созданной до появления tracks:  ALTER TABLE patients ADD COLUMN tracks TEXT;
CREATE INDEX IF NOT EXISTS patients_active ON patients(active);

-- Кому какое сообщение рассылки уже ушло (чтобы никто не получил дважды)
CREATE TABLE IF NOT EXISTS sends (
  campaign TEXT NOT NULL,        -- day1 … day7, release
  id       INTEGER NOT NULL,     -- Telegram ID
  status   TEXT NOT NULL,        -- ok | blocked | error
  ts       INTEGER NOT NULL,
  PRIMARY KEY (campaign, id)
);
