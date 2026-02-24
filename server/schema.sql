-- ClawAI Town Database Schema
-- Run this after creating your PostgreSQL database on Render

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  framework TEXT NOT NULL,
  pubkey TEXT,
  status TEXT DEFAULT 'offline',
  sol_balance DECIMAL DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  total_fights INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  bettor TEXT NOT NULL,
  amount DECIMAL NOT NULL,
  type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sponsors (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  sponsor TEXT NOT NULL,
  amount DECIMAL NOT NULL,
  share DECIMAL DEFAULT 0.10,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_bets_bettor ON bets(bettor);
CREATE INDEX IF NOT EXISTS idx_sponsors_sponsor ON sponsors(sponsor);
