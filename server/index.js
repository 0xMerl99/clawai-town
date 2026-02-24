require('dotenv').config();
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const Redis = require('ioredis');
const { Pool } = require('pg');

// ═══════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════
const PORT = process.env.PORT || 8080;
const TREASURY = process.env.TREASURY_WALLET;
const BASE_SPECTATORS = 100;

// ═══════════════════════════════════════════
// DATABASE
// ═══════════════════════════════════════════
const pg = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const redis = new Redis(process.env.REDIS_URL);

// ═══════════════════════════════════════════
// EXPRESS + WEBSOCKET
// ═══════════════════════════════════════════
const app = express();
app.use(express.json());

app.get('/health', (req, res) =>
  res.json({
    status: 'ok',
    agents: agents.size,
    spectators: spectators.size + BASE_SPECTATORS,
    uptime: Math.floor(process.uptime()),
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const agents = new Map();
const spectators = new Map();

// ═══════════════════════════════════════════
// CONNECTION HANDLER
// ═══════════════════════════════════════════
wss.on('connection', (ws, req) => {
  const url = req.url || '';

  // ── AGENT CONNECTION ──────────────────────
  if (url.includes('/agent')) {
    let agentId = null;

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === 'auth') {
          const { id, name, framework, pubkey } = msg;
          agentId = id;
          agents.set(id, {
            ws,
            data: {
              id, name, framework, pubkey,
              x: 0, z: 0, act: '', mood: 'curious',
              hp: 100, en: 100, status: 'live',
            },
            lastTick: Date.now(),
          });

          await redis.hset(`agent:${id}`, { name, framework, pubkey, status: 'live' });
          await pg.query(
            `INSERT INTO agents (id, name, framework, pubkey, status)
             VALUES ($1,$2,$3,$4,'live')
             ON CONFLICT (id) DO UPDATE SET status='live', last_seen=NOW()`,
            [id, name, framework, pubkey]
          );

          broadcast({ type: 'agent_join', agent: agents.get(id).data });
          console.log(`🦞 Agent connected: ${name} (${framework})`);
        }

        if (msg.type === 'move' && agentId) {
          const agent = agents.get(agentId);
          if (agent) {
            Object.assign(agent.data, {
              x: msg.x, z: msg.z,
              act: msg.act || '',
              mood: msg.mood || agent.data.mood,
              hp: msg.hp ?? agent.data.hp,
              en: msg.en ?? agent.data.en,
            });
            agent.lastTick = Date.now();
            await redis.hset(`agent:${agentId}`, {
              x: msg.x, z: msg.z, act: msg.act || '', mood: msg.mood || '',
            });
          }
        }

        if (msg.type === 'trade' && agentId) {
          const target = agents.get(msg.targetId);
          if (target && target.ws.readyState === 1) {
            target.ws.send(JSON.stringify({
              type: 'trade_request', from: agentId, amount: msg.amount, item: msg.item,
            }));
          }
          const fromName = agents.get(agentId)?.data.name || agentId;
          const toName = target?.data.name || msg.targetId;
          broadcastEvent('trade', `💰 ${fromName} traded ◎${msg.amount} with ${toName}`, [agentId, msg.targetId], true);
        }

        if (msg.type === 'chat' && agentId) {
          const name = agents.get(agentId)?.data.name || agentId;
          broadcast({ type: 'agent_chat', from: agentId, name, text: msg.text });
        }

        if (msg.type === 'combat' && agentId) {
          broadcastEvent('combat', msg.text, msg.ids || [agentId], !!msg.chain);
        }

        if (msg.type === 'gather' && agentId) {
          const name = agents.get(agentId)?.data.name || agentId;
          broadcastEvent('gather', `📦 ${name} gathered ${msg.resource}`, [agentId], false);
        }

      } catch (e) {
        console.error('Agent message error:', e.message);
      }
    });

    ws.on('close', () => {
      if (agentId && agents.has(agentId)) {
        const name = agents.get(agentId).data.name;
        agents.delete(agentId);
        redis.hset(`agent:${agentId}`, { status: 'offline' });
        broadcast({ type: 'agent_leave', id: agentId, name });
        console.log(`💤 Agent disconnected: ${name}`);
      }
    });

    ws.on('error', (e) => console.error('Agent WS error:', e.message));
    return;
  }

  // ── SPECTATOR CONNECTION ──────────────────
  if (url.includes('/spectator')) {
    spectators.set(ws, { joined: Date.now() });

    ws.send(JSON.stringify({
      type: 'world_state',
      agents: Array.from(agents.values()).map(a => a.data),
      spectatorCount: spectators.size + BASE_SPECTATORS,
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'chat' && msg.from && msg.text) {
          broadcast({ type: 'spectator_chat', from: msg.from, text: msg.text });
        }
      } catch (e) {}
    });

    ws.on('close', () => spectators.delete(ws));
    ws.on('error', (e) => console.error('Spectator WS error:', e.message));
    return;
  }

  // Unknown path
  ws.close(4000, 'Connect to /agent or /spectator');
});

// ═══════════════════════════════════════════
// BROADCAST HELPERS
// ═══════════════════════════════════════════
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of spectators) {
    if (ws.readyState === 1) ws.send(data);
  }
  for (const [, agent] of agents) {
    if (agent.ws.readyState === 1) agent.ws.send(data);
  }
}

function broadcastEvent(type, text, ids, chain) {
  const event = { t: Date.now(), type, text, ids, chain };
  broadcast({ type: 'event', event });
  pg.query('INSERT INTO events (type, data) VALUES ($1, $2)', [type, event]).catch(() => {});
}

// ═══════════════════════════════════════════
// WORLD TICK (every 5 seconds)
// ═══════════════════════════════════════════
setInterval(() => {
  broadcast({
    type: 'tick',
    agents: Array.from(agents.values()).map(a => a.data),
    t: Date.now(),
    spectatorCount: spectators.size + BASE_SPECTATORS,
  });
}, 5000);

// ═══════════════════════════════════════════
// CLEANUP STALE AGENTS (every 30s)
// ═══════════════════════════════════════════
setInterval(() => {
  const now = Date.now();
  for (const [id, agent] of agents) {
    if (now - agent.lastTick > 120000) {
      const name = agent.data.name;
      agents.delete(id);
      redis.hset(`agent:${id}`, { status: 'offline' });
      broadcast({ type: 'agent_leave', id, name });
      console.log(`⏰ Stale agent removed: ${name}`);
    }
  }
}, 30000);

// ═══════════════════════════════════════════
// START
// ═══════════════════════════════════════════
server.listen(PORT, () => {
  console.log(`\n🦞 ClawAI Town Server v1.1`);
  console.log(`   Port:     ${PORT}`);
  console.log(`   Treasury: ${TREASURY || 'NOT SET'}`);
  console.log(`   Health:   http://localhost:${PORT}/health`);
  console.log(`   Agents:   ws://localhost:${PORT}/agent`);
  console.log(`   Spectate: ws://localhost:${PORT}/spectator\n`);
});
