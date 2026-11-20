-- Muse bridge schema. All timestamps are unix epoch milliseconds.

CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  source_note TEXT
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES batches(id),
  dedupe_key TEXT NOT NULL UNIQUE,
  soft_key TEXT NOT NULL,
  site_key TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  ats TEXT NOT NULL,
  location TEXT,
  deadline TEXT,
  eligibility TEXT NOT NULL DEFAULT 'unstated',
  grad_year_evidence TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  status_reason TEXT,
  lease_token TEXT,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  leases INTEGER NOT NULL DEFAULT 0,
  expired_leases INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before INTEGER,
  waiting_since INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  confirmation TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX jobs_status ON jobs(status, priority, created_at);
CREATE INDEX jobs_soft ON jobs(soft_key);
CREATE INDEX jobs_site ON jobs(site_key, status);
CREATE INDEX jobs_owner ON jobs(lease_owner, status);

CREATE TABLE lease_history (
  token TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  final_status TEXT
);
CREATE INDEX lease_history_job ON lease_history(job_id);

CREATE TABLE workers (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  lease_token TEXT,
  kind TEXT NOT NULL,
  question TEXT NOT NULL,
  norm TEXT NOT NULL,
  options_json TEXT,
  context TEXT,
  word_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  flags TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX questions_status ON questions(status, kind);
CREATE INDEX questions_norm ON questions(norm, status);

CREATE TABLE job_blockers (
  job_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  PRIMARY KEY (job_id, question_id)
);
CREATE INDEX job_blockers_q ON job_blockers(question_id);

CREATE TABLE question_polls (
  question_id INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  polls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_id, job_id)
);

CREATE TABLE essays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_norm TEXT NOT NULL,
  prompt_norm TEXT NOT NULL,
  company TEXT NOT NULL,
  prompt TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (company_norm, prompt_norm)
);

CREATE TABLE answer_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  norm TEXT NOT NULL UNIQUE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  keywords TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_key TEXT NOT NULL UNIQUE,
  login_email TEXT NOT NULL,
  password_ciphertext TEXT,
  iv TEXT,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  notes TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  job_id INTEGER,
  detail TEXT
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_type ON events(type, ts);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('paused', '0'),
  ('lease_minutes', '20'),
  ('submit_extend_minutes', '15'),
  ('max_attempts', '3'),
  ('max_expired_leases', '3'),
  ('max_answer_polls', '3'),
  ('code_wait_s', '20'),
  ('waiting_timeout_hours', '72'),
  ('batch_low_threshold', '25'),
  ('credential_creates_per_hour', '30');
