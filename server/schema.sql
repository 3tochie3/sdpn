-- Пациенты, вставшие на учёт. Только то, что нужно для рассылки.
CREATE TABLE IF NOT EXISTS patients (
  id      INTEGER PRIMARY KEY,   -- Telegram ID
  track   TEXT NOT NULL,         -- id назначенного трека (как в CONTENT.tracks)
  form    TEXT,                  -- код формы, например СДПН-03
  card    TEXT,                  -- номер карты, например СДПН-428
  created INTEGER NOT NULL,      -- когда встал на учёт (мс)
  active  INTEGER NOT NULL DEFAULT 1  -- 0 = снят с учёта (/stop или заблокировал бота)
);
CREATE INDEX IF NOT EXISTS patients_active ON patients(active);
