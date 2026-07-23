require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.set('trust proxy', 1);

// ── DOMEIN-REDIRECT ───────────────────────────────────────────────────
// Bij een domeinwissel blijven oude links werken: alleen de expliciet in
// LEGACY_HOSTS genoemde hostnames worden doorgestuurd naar CANONICAL_HOST,
// met pad én querystring intact (?teamonderzoek=, ?share=, ?code= moeten mee).
// Alleen die hosts, zodat de Railway-healthcheck en het railway.app-domein
// gewoon 200 blijven geven. Zonder beide env-vars gebeurt er niets.
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim().toLowerCase();
const LEGACY_HOSTS = (process.env.LEGACY_HOSTS || '')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
if (CANONICAL_HOST && LEGACY_HOSTS.length) {
  app.use((req, res, next) => {
    if (!LEGACY_HOSTS.includes((req.hostname || '').toLowerCase())) return next();
    // 302, niet 301: een 301 wordt permanent in browsers gecached en is
    // daarna niet meer terug te draaien. Pas op 301 zetten als het definitief is.
    res.redirect(302, 'https://' + CANONICAL_HOST + req.originalUrl);
  });
}

app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// ── SECRETS ───────────────────────────────────────────────────────────
// No guessable defaults: an unset session token becomes a random per-boot
// value. The client only ever receives it from /api/admin/login, so a random
// token works fine — it just means admin sessions end when the server restarts.
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_SESSION_TOKEN = process.env.ADMIN_SESSION_TOKEN || crypto.randomBytes(32).toString('hex');
if (!process.env.ADMIN_SESSION_TOKEN) {
  console.warn('ADMIN_SESSION_TOKEN niet gezet — willekeurig token gegenereerd voor deze run. Admin-sessies vervallen bij herstart.');
}

// ── DATABASE ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// A dropped idle connection (managed Postgres closes idle clients) emits an
// 'error' on the pool. Without this listener Node treats it as an unhandled
// error event and crashes the whole process — the main cause of intermittent
// "server not found" downtime. Log it and let the pool recover on next query.
pool.on('error', (err) => {
  console.error('Unexpected idle DB client error:', err.message);
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS organisations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      first_name TEXT NOT NULL,
      last_name TEXT,
      email TEXT,
      code TEXT UNIQUE NOT NULL,
      logged_in BOOLEAN DEFAULT FALSE,
      completed BOOLEAN DEFAULT FALSE,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS answers (
      participant_id TEXT REFERENCES participants(id) ON DELETE CASCADE,
      question_id TEXT NOT NULL,
      value INTEGER NOT NULL CHECK (value BETWEEN 1 AND 5),
      answered_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (participant_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      theme TEXT NOT NULL,
      text TEXT NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS themes (
      name TEXT PRIMARY KEY,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS dimensions (
      name TEXT PRIMARY KEY,
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      org_id TEXT,
      is_individual BOOLEAN DEFAULT FALSE,
      participant_id TEXT,
      participant_name TEXT,
      data JSONB NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS knowledge_base (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS shared_reports (
      token TEXT PRIMARY KEY,
      report_id TEXT NOT NULL,
      password_hash TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS lead_links (
      token TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      clicks INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- One row per (link, browser). Lets us report unique visitors next to the
    -- raw click count without storing anything personal.
    CREATE TABLE IF NOT EXISTS lead_link_visits (
      link_token TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      first_seen TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (link_token, visitor_id)
    );
  `);

  // ── MIGRATIONS (additive, safe to run repeatedly) ───────────────────
  await pool.query("ALTER TABLE organisations ADD COLUMN IF NOT EXISTS is_leads BOOLEAN DEFAULT FALSE");
  await pool.query("ALTER TABLE themes ADD COLUMN IF NOT EXISTS dimension TEXT");
  // Shared links carry their own report snapshot so they stay readable (and
  // stop leaking into the admin report list as orphan rows).
  await pool.query("ALTER TABLE shared_reports ADD COLUMN IF NOT EXISTS data JSONB");
  // Which shareable lead link a lead came in through (NULL for the legacy link).
  await pool.query("ALTER TABLE participants ADD COLUMN IF NOT EXISTS lead_link_token TEXT");
  await pool.query("CREATE INDEX IF NOT EXISTS idx_participants_lead_link ON participants (lead_link_token)");

  // Seed default dimensions + theme→dimension mapping (only on first run)
  const dimCount = await pool.query('SELECT COUNT(*) as c FROM dimensions');
  if (parseInt(dimCount.rows[0].c) === 0) {
    const defaults = [
      { name: 'Bestaansrecht', desc: 'Het bestaansrecht van een team is de reden dat ze op aarde zijn. Een team zet doelen om in resultaten.', themes: ['Doelen', 'Resultaten'] },
      { name: 'Inrichting', desc: 'Inrichting is de manier waarop je menselijk kapitaal inzet, procedures structureert en ondersteunende processen inricht.', themes: ['De mensen', 'Overleg'] },
      { name: 'Dynamiek', desc: 'In de dynamiek komt de samenwerking tot leven. Hier spelen persoonlijke behoefte en groepsbelang een rol.', themes: ['Samenwerken', 'Communicatie', 'Omgang met elkaar', 'Besluitvorming', 'Teamleider'] },
      { name: 'Omgeving', desc: 'Als team lever je een dienst aan je omgeving. Tegelijkertijd heb je de omgeving nodig voor resources en als samenwerkingspartner.', themes: ["Collega's van andere teams", 'Krachtenveld'] }
    ];
    for (let i = 0; i < defaults.length; i++) {
      const d = defaults[i];
      await pool.query('INSERT INTO dimensions (name, description, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [d.name, d.desc, i + 1]);
      for (const t of d.themes) {
        await pool.query('UPDATE themes SET dimension = $1 WHERE name = $2', [d.name, t]);
      }
    }
  }

  // Ensure the special Leads organisation exists
  await pool.query(
    "INSERT INTO organisations (id, name, is_leads) VALUES ('LEADS', 'Leads', TRUE) ON CONFLICT (id) DO UPDATE SET is_leads = TRUE"
  );

  // ADMIN_PASSWORD is authoritative when set, so the password can be rotated by
  // changing the env var and redeploying. Without it, a first run generates a
  // random password rather than falling back to a known default.
  const existing = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
  if (process.env.ADMIN_PASSWORD) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('admin_password', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [JSON.stringify(hash)]
    );
  } else if (existing.rows.length === 0) {
    const generated = crypto.randomBytes(12).toString('base64url');
    const hash = await bcrypt.hash(generated, 10);
    await pool.query("INSERT INTO settings (key, value) VALUES ('admin_password', $1)", [JSON.stringify(hash)]);
    console.warn('ADMIN_PASSWORD niet gezet. Gegenereerd admin-wachtwoord (wordt niet opnieuw getoond): ' + generated);
  }

  console.log('Database initialised');
}

// ── HELPERS ───────────────────────────────────────────────────────────
function uid() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return 'TBQ-' + s;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Log the real cause server-side, return a generic Dutch message to the client.
function fail(res, status, message, err) {
  if (err) console.error(message, err.stack || err.message || err);
  res.status(status).json({ error: message });
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !safeEqual(token, ADMIN_SESSION_TOKEN)) {
    return res.status(401).json({ error: 'Niet geautoriseerd' });
  }
  next();
}

// Small in-memory limiter — enough to stop code/password guessing on a
// single-instance deploy.
const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || now > entry.reset) {
    rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) if (now > entry.reset) rateBuckets.delete(key);
}, 60000).unref();

// Confirms a participant owns the id they claim, using the code they logged in with.
async function verifyParticipant(participantId, code) {
  if (!participantId || !code) return null;
  const res = await pool.query(
    'SELECT id, completed FROM participants WHERE id = $1 AND code = $2',
    [participantId, String(code).trim().toUpperCase()]
  );
  return res.rows[0] || null;
}

// ── AUTH ENDPOINTS ────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  try {
    if (!rateLimit('admin-login:' + req.ip, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Te veel inlogpogingen. Probeer het over 15 minuten opnieuw.' });
    }
    const { username, password } = req.body || {};
    const result = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
    const hash = result.rows.length ? result.rows[0].value : null;
    const ok = hash && username === ADMIN_USERNAME && await bcrypt.compare(String(password || ''), hash);
    if (!ok) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
    res.json({ token: ADMIN_SESSION_TOKEN });
  } catch (e) {
    fail(res, 500, 'Inloggen is mislukt. Probeer het opnieuw.', e);
  }
});

app.post('/api/participant/login', async (req, res) => {
  try {
    if (!rateLimit('p-login:' + req.ip, 60, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Te veel pogingen. Probeer het later opnieuw.' });
    }
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code ontbreekt' });
    const result = await pool.query(
      `SELECT p.*, t.name as team_name, t.id as team_id, o.name as org_name
       FROM participants p
       JOIN teams t ON p.team_id = t.id
       JOIN organisations o ON t.org_id = o.id
       WHERE p.code = $1`, [String(code).trim().toUpperCase()]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Code niet gevonden' });
    const p = result.rows[0];
    if (p.completed) return res.status(400).json({ error: 'Je hebt de vragenlijst al ingevuld' });
    await pool.query('UPDATE participants SET logged_in = TRUE WHERE id = $1', [p.id]);
    res.json({
      id: p.id,
      firstName: p.first_name,
      lastName: p.last_name,
      name: [p.first_name, p.last_name].filter(Boolean).join(' '),
      code: p.code,
      teamId: p.team_id,
      teamName: p.team_name,
      orgName: p.org_name
    });
  } catch (e) {
    fail(res, 500, 'Inloggen is mislukt. Probeer het opnieuw.', e);
  }
});

// ── QUESTIONS & THEMES (public) ───────────────────────────────────────
// Eén volgorde voor de hele app: eerst het Team Shapers Thema, daarbinnen het
// subthema, daarbinnen de vraag — precies zoals de lijst in het beheerscherm.
// Subthema's zonder hoofdthema komen achteraan.
const QUESTION_ORDER = 'COALESCE(d.sort_order, 9999), t.sort_order, q.sort_order, q.created_at';
const THEME_ORDER_QUERY =
  `SELECT t.name, t.dimension FROM themes t
   LEFT JOIN dimensions d ON t.dimension = d.name
   ORDER BY COALESCE(d.sort_order, 9999), t.sort_order`;

app.get('/api/questions', async (req, res) => {
  try {
    const qs = await pool.query(
      `SELECT q.* FROM questions q
       JOIN themes t ON q.theme = t.name
       LEFT JOIN dimensions d ON t.dimension = d.name
       WHERE q.active = TRUE
       ORDER BY ${QUESTION_ORDER}`
    );
    const themes = await pool.query(THEME_ORDER_QUERY);
    res.json({
      questions: qs.rows.map(q => ({ id: q.id, theme: q.theme, text: q.text, active: q.active })),
      themes: themes.rows.map(t => t.name)
    });
  } catch (e) {
    fail(res, 500, 'Vragen konden niet geladen worden.', e);
  }
});

// ── ANSWERS ───────────────────────────────────────────────────────────
app.post('/api/answers', async (req, res) => {
  let client;
  let inTransaction = false;
  try {
    const { participantId, code, answers } = req.body || {};
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ error: 'Ongeldige antwoorden' });
    }
    const participant = await verifyParticipant(participantId, code);
    if (!participant) return res.status(403).json({ error: 'Niet geautoriseerd' });
    if (participant.completed) return res.status(409).json({ error: 'Je hebt de vragenlijst al ingevuld' });

    const entries = Object.entries(answers);
    if (!entries.length) return res.json({ ok: true });
    if (entries.length > 500) return res.status(400).json({ error: 'Te veel antwoorden in één verzoek' });
    for (const [, val] of entries) {
      const v = Number(val);
      if (!Number.isInteger(v) || v < 1 || v > 5) return res.status(400).json({ error: 'Ongeldige antwoordwaarde' });
    }
    const known = await pool.query('SELECT id FROM questions WHERE id = ANY($1::text[])', [entries.map(e => e[0])]);
    const knownIds = new Set(known.rows.map(r => r.id));
    if (knownIds.size !== entries.length) return res.status(400).json({ error: 'Onbekende vraag' });

    client = await pool.connect();
    await client.query('BEGIN');
    inTransaction = true;
    for (const [qid, val] of entries) {
      await client.query(
        `INSERT INTO answers (participant_id, question_id, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (participant_id, question_id) DO UPDATE SET value = $3`,
        [participantId, qid, Number(val)]
      );
    }
    await client.query('COMMIT');
    inTransaction = false;
    res.json({ ok: true });
  } catch (e) {
    if (client && inTransaction) await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Antwoord opslaan is mislukt.', e);
  } finally {
    if (client) client.release();
  }
});

app.post('/api/answers/complete', async (req, res) => {
  try {
    const { participantId, code } = req.body || {};
    const participant = await verifyParticipant(participantId, code);
    if (!participant) return res.status(403).json({ error: 'Niet geautoriseerd' });
    await pool.query(
      'UPDATE participants SET completed = TRUE, completed_at = NOW() WHERE id = $1',
      [participantId]
    );
    res.json({ ok: true });
    // Reports involve an AI call that can take a minute — never make the
    // participant wait for it.
    autoGenerateReports(participantId);
  } catch (e) {
    fail(res, 500, 'Afronden is mislukt.', e);
  }
});

// ── ADMIN: ORGANISATIONS & TEAMS ──────────────────────────────────────
app.get('/api/admin/organisations', adminAuth, async (req, res) => {
  try {
    const orgs = await pool.query('SELECT * FROM organisations ORDER BY created_at');
    const teams = await pool.query('SELECT * FROM teams ORDER BY created_at');
    const participants = await pool.query('SELECT * FROM participants ORDER BY created_at');
    const answerCounts = await pool.query(
      'SELECT participant_id, COUNT(*) as count FROM answers GROUP BY participant_id'
    );
    const countMap = {};
    answerCounts.rows.forEach(r => { countMap[r.participant_id] = parseInt(r.count); });

    const result = orgs.rows.map(org => ({
      ...org,
      teams: teams.rows
        .filter(t => t.org_id === org.id)
        .map(team => ({
          ...team,
          participants: participants.rows.filter(p => p.team_id === team.id).map(p => ({
            id: p.id,
            firstName: p.first_name,
            lastName: p.last_name || '',
            name: [p.first_name, p.last_name].filter(Boolean).join(' '),
            email: p.email,
            code: p.code,
            loggedIn: p.logged_in,
            completed: p.completed,
            completedAt: p.completed_at,
            createdAt: p.created_at,
            leadLinkToken: p.lead_link_token || null,
            answerCount: countMap[p.id] || 0
          }))
        }))
    }));
    res.json(result);
  } catch (e) {
    fail(res, 500, 'Organisaties konden niet geladen worden.', e);
  }
});

app.post('/api/admin/organisations', adminAuth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam is verplicht.' });
    const id = uid();
    await pool.query('INSERT INTO organisations (id, name) VALUES ($1, $2)', [id, String(name).trim()]);
    res.json({ id, name: String(name).trim() });
  } catch (e) {
    fail(res, 500, 'Organisatie toevoegen is mislukt.', e);
  }
});

app.delete('/api/admin/organisations/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM organisations WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Organisatie verwijderen is mislukt.', e);
  }
});

app.post('/api/admin/teams', adminAuth, async (req, res) => {
  try {
    const { orgId, name } = req.body || {};
    if (!orgId || !name || !String(name).trim()) return res.status(400).json({ error: 'Naam is verplicht.' });
    const id = uid();
    await pool.query('INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)', [id, orgId, String(name).trim()]);
    res.json({ id, orgId, name: String(name).trim() });
  } catch (e) {
    fail(res, 500, 'Team toevoegen is mislukt.', e);
  }
});

app.delete('/api/admin/teams/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Team verwijderen is mislukt.', e);
  }
});

app.post('/api/admin/participants', adminAuth, async (req, res) => {
  try {
    const { teamId, firstName, lastName, email } = req.body || {};
    if (!teamId || !firstName || !String(firstName).trim()) {
      return res.status(400).json({ error: 'Voornaam is verplicht.' });
    }
    const id = uid();
    const code = genCode();
    await pool.query(
      'INSERT INTO participants (id, team_id, first_name, last_name, email, code) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, teamId, String(firstName).trim(), lastName || null, email || null, code]
    );
    res.json({ id, teamId, firstName, lastName, code });
  } catch (e) {
    fail(res, 500, 'Deelnemer toevoegen is mislukt.', e);
  }
});

app.delete('/api/admin/participants/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM participants WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Deelnemer verwijderen is mislukt.', e);
  }
});

// ── ADMIN: QUESTIONS ─────────────────────────────────────────────────
app.get('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    const qs = await pool.query(
      `SELECT q.* FROM questions q
       JOIN themes t ON q.theme = t.name
       LEFT JOIN dimensions d ON t.dimension = d.name
       ORDER BY ${QUESTION_ORDER}`
    );
    const themes = await pool.query(THEME_ORDER_QUERY);
    const dims = await pool.query('SELECT name, description, sort_order FROM dimensions ORDER BY sort_order');
    const themeDim = {};
    themes.rows.forEach(t => { themeDim[t.name] = t.dimension || null; });
    res.json({
      questions: qs.rows,
      themes: themes.rows.map(t => t.name),
      themeDim: themeDim,
      dimensions: dims.rows.map(d => ({ name: d.name, description: d.description || '', sortOrder: d.sort_order }))
    });
  } catch (e) {
    fail(res, 500, 'Vragen konden niet geladen worden.', e);
  }
});

app.post('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    const { theme, text } = req.body || {};
    if (!theme || !text || !String(text).trim()) return res.status(400).json({ error: 'Vraagtekst is verplicht.' });
    const id = uid();
    const max = await pool.query('SELECT COALESCE(MAX(sort_order),0) as m FROM questions WHERE theme=$1', [theme]);
    await pool.query(
      'INSERT INTO questions (id, theme, text, sort_order) VALUES ($1,$2,$3,$4)',
      [id, theme, String(text).trim(), (max.rows[0].m || 0) + 1]
    );
    res.json({ id, theme, text: String(text).trim(), active: true });
  } catch (e) {
    fail(res, 500, 'Vraag toevoegen is mislukt.', e);
  }
});

app.put('/api/admin/questions/reorder', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order)) return res.status(400).json({ error: 'Ongeldige volgorde' });
    await client.query('BEGIN');
    for (const item of order) {
      await client.query(
        'UPDATE questions SET sort_order=$1, theme=$2 WHERE id=$3',
        [item.sortOrder, item.theme, item.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Volgorde opslaan is mislukt.', e);
  } finally {
    client.release();
  }
});

app.put('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    const { theme, text, active } = req.body || {};
    await pool.query(
      'UPDATE questions SET theme=$1, text=$2, active=$3 WHERE id=$4',
      [theme, text, active, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Vraag opslaan is mislukt.', e);
  }
});

app.delete('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Vraag verwijderen is mislukt.', e);
  }
});

app.post('/api/admin/themes', adminAuth, async (req, res) => {
  try {
    const { name, dimension } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Naam is verplicht.' });
    const max = await pool.query('SELECT COALESCE(MAX(sort_order),0) as m FROM themes');
    await pool.query(
      'INSERT INTO themes (name, sort_order, dimension) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [String(name).trim(), (max.rows[0].m || 0) + 1, dimension || null]
    );
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Thema toevoegen is mislukt.', e);
  }
});

app.delete('/api/admin/themes/:name', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const name = decodeURIComponent(req.params.name);
    await client.query('BEGIN');
    await client.query('DELETE FROM themes WHERE name = $1', [name]);
    await client.query('DELETE FROM questions WHERE theme = $1', [name]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Thema verwijderen is mislukt.', e);
  } finally {
    client.release();
  }
});

// Rename a theme and/or (re)assign its dimension. Cascades the new name to questions.
app.put('/api/admin/themes/:name', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { name, dimension } = req.body || {};
    const newName = (name || '').trim() || oldName;
    await client.query('BEGIN');
    if (newName !== oldName) {
      const exists = await client.query('SELECT 1 FROM themes WHERE name = $1', [newName]);
      if (exists.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Er bestaat al een thema met deze naam.' });
      }
      await client.query('UPDATE themes SET name = $1 WHERE name = $2', [newName, oldName]);
      await client.query('UPDATE questions SET theme = $1 WHERE theme = $2', [newName, oldName]);
    }
    await client.query('UPDATE themes SET dimension = $1 WHERE name = $2', [dimension || null, newName]);
    await client.query('COMMIT');
    res.json({ ok: true, name: newName });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Thema opslaan is mislukt.', e);
  } finally {
    client.release();
  }
});

// ── ADMIN: DIMENSIONS ─────────────────────────────────────────────────
app.post('/api/admin/dimensions', adminAuth, async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Naam is verplicht.' });
    const max = await pool.query('SELECT COALESCE(MAX(sort_order),0) as m FROM dimensions');
    await pool.query(
      'INSERT INTO dimensions (name, description, sort_order) VALUES ($1,$2,$3) ON CONFLICT (name) DO NOTHING',
      [name.trim(), description || '', (max.rows[0].m || 0) + 1]
    );
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Team Shapers Thema toevoegen is mislukt.', e);
  }
});

// Reorder dimensions (must be registered before the /:name route)
app.put('/api/admin/dimensions/reorder', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { order } = req.body || {}; // array of dimension names in the desired order
    if (!Array.isArray(order)) return res.status(400).json({ error: 'Ongeldige volgorde' });
    await client.query('BEGIN');
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE dimensions SET sort_order = $1 WHERE name = $2', [i + 1, order[i]]);
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Volgorde opslaan is mislukt.', e);
  } finally {
    client.release();
  }
});

// Rename a dimension and/or update its description. Cascades the new name to themes.
app.put('/api/admin/dimensions/:name', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const oldName = decodeURIComponent(req.params.name);
    const { name, description } = req.body || {};
    const newName = (name || '').trim() || oldName;
    await client.query('BEGIN');
    if (newName !== oldName) {
      const exists = await client.query('SELECT 1 FROM dimensions WHERE name = $1', [newName]);
      if (exists.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Er bestaat al een Team Shapers Thema met deze naam.' });
      }
      await client.query('UPDATE dimensions SET name = $1 WHERE name = $2', [newName, oldName]);
      await client.query('UPDATE themes SET dimension = $1 WHERE dimension = $2', [newName, oldName]);
    }
    await client.query('UPDATE dimensions SET description = $1 WHERE name = $2', [description || '', newName]);
    await client.query('COMMIT');
    res.json({ ok: true, name: newName });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Team Shapers Thema opslaan is mislukt.', e);
  } finally {
    client.release();
  }
});

app.delete('/api/admin/dimensions/:name', adminAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const name = decodeURIComponent(req.params.name);
    await client.query('BEGIN');
    await client.query('UPDATE themes SET dimension = NULL WHERE dimension = $1', [name]);
    await client.query('DELETE FROM dimensions WHERE name = $1', [name]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    fail(res, 500, 'Team Shapers Thema verwijderen is mislukt.', e);
  } finally {
    client.release();
  }
});

// ── LEAD LINKS (multiple shareable links + per-link statistics) ───────
app.get('/api/admin/lead-links', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.token, l.name, l.clicks, l.created_at,
              (SELECT COUNT(*)::int FROM lead_link_visits v WHERE v.link_token = l.token) AS unique_clicks,
              (SELECT COUNT(*)::int FROM participants p WHERE p.lead_link_token = l.token) AS registrations,
              (SELECT COUNT(*)::int FROM participants p WHERE p.lead_link_token = l.token AND p.completed) AS completed
       FROM lead_links l
       ORDER BY l.created_at DESC`
    );
    res.json(result.rows.map(r => ({
      token: r.token,
      name: r.name,
      clicks: r.clicks || 0,
      uniqueClicks: r.unique_clicks || 0,
      registrations: r.registrations || 0,
      completed: r.completed || 0,
      createdAt: r.created_at
    })));
  } catch (e) {
    fail(res, 500, 'Links konden niet geladen worden.', e);
  }
});

app.post('/api/admin/lead-links', adminAuth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Geef de link een naam.' });
    const token = crypto.randomBytes(9).toString('base64url');
    const clean = String(name).trim().slice(0, 120);
    await pool.query('INSERT INTO lead_links (token, name) VALUES ($1, $2)', [token, clean]);
    res.json({ token, name: clean, clicks: 0, uniqueClicks: 0, registrations: 0, completed: 0 });
  } catch (e) {
    fail(res, 500, 'Link aanmaken is mislukt.', e);
  }
});

app.put('/api/admin/lead-links/:token', adminAuth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Geef de link een naam.' });
    await pool.query('UPDATE lead_links SET name = $1 WHERE token = $2', [String(name).trim().slice(0, 120), req.params.token]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Link hernoemen is mislukt.', e);
  }
});

// Deleting a link only stops it working — the leads it produced stay in the list.
app.delete('/api/admin/lead-links/:token', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM lead_link_visits WHERE link_token = $1', [req.params.token]);
    await pool.query('DELETE FROM lead_links WHERE token = $1', [req.params.token]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Link verwijderen is mislukt.', e);
  }
});

// Public: a link was opened. visitorId is a random id the browser keeps in
// localStorage, so a reload by the same person does not count as a new visitor.
app.post('/api/lead/click/:token', async (req, res) => {
  try {
    if (!rateLimit('lead-click:' + req.ip, 120, 60 * 60 * 1000)) return res.json({ ok: true });
    const token = req.params.token;
    const exists = await pool.query('SELECT 1 FROM lead_links WHERE token = $1', [token]);
    if (!exists.rows.length) return res.json({ ok: true });
    await pool.query('UPDATE lead_links SET clicks = clicks + 1 WHERE token = $1', [token]);
    const visitorId = String((req.body || {}).visitorId || '').slice(0, 64);
    if (visitorId) {
      await pool.query(
        'INSERT INTO lead_link_visits (link_token, visitor_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [token, visitorId]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    // Statistics must never block someone from filling in the questionnaire.
    console.error('Klik registreren mislukt:', e.message);
    res.json({ ok: true });
  }
});

// ── LEADS (public self-registration) ──────────────────────────────────
app.post('/api/lead/register', async (req, res) => {
  try {
    if (!rateLimit('lead:' + req.ip, 20, 60 * 60 * 1000)) {
      return res.status(429).json({ error: 'Te veel aanmeldingen. Probeer het later opnieuw.' });
    }
    const { name, orgName, linkToken } = req.body || {};
    if (!name || !String(name).trim() || !orgName || !String(orgName).trim()) {
      return res.status(400).json({ error: 'Vul je naam en organisatienaam in.' });
    }
    const cleanName = String(name).trim().slice(0, 120);
    const cleanOrg = String(orgName).trim().slice(0, 120);
    // Group leads by the organisation name they enter (a team under the Leads org)
    const team = await pool.query(
      "SELECT id FROM teams WHERE org_id = 'LEADS' AND LOWER(name) = LOWER($1)",
      [cleanOrg]
    );
    let teamId;
    if (team.rows.length) {
      teamId = team.rows[0].id;
    } else {
      teamId = uid();
      await pool.query('INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)', [teamId, 'LEADS', cleanOrg]);
    }
    const id = uid();
    const code = genCode();
    // Only attribute to a link that actually exists, so the token cannot be faked.
    let token = null;
    if (linkToken) {
      const link = await pool.query('SELECT token FROM lead_links WHERE token = $1', [String(linkToken)]);
      if (link.rows.length) token = link.rows[0].token;
    }
    await pool.query(
      'INSERT INTO participants (id, team_id, first_name, code, lead_link_token) VALUES ($1,$2,$3,$4,$5)',
      [id, teamId, cleanName, code, token]
    );
    res.json({ code });
  } catch (e) {
    fail(res, 500, 'Aanmelden is mislukt. Probeer het opnieuw.', e);
  }
});

// ── ADMIN: ANSWERS (for reports) ──────────────────────────────────────
app.get('/api/admin/answers/:participantId', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT question_id, value FROM answers WHERE participant_id = $1',
      [req.params.participantId]
    );
    const answers = {};
    result.rows.forEach(r => { answers[r.question_id] = r.value; });
    res.json(answers);
  } catch (e) {
    fail(res, 500, 'Antwoorden konden niet geladen worden.', e);
  }
});

// ── AI (server-side only; the API key and the prompts never reach the client) ──
const AI_MODEL = 'claude-sonnet-4-6';
const AI_TIMEOUT_MS = 60000;

async function callClaude(prompt, maxTokens) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is niet geconfigureerd');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: Math.min(Number(maxTokens) || 2000, 4000),
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => null);
    // Anthropic errors must not be mistaken for empty advice.
    if (!response.ok || !data || data.type === 'error') {
      const detail = (data && data.error && data.error.message) || ('HTTP ' + response.status);
      throw new Error('AI-service gaf een fout: ' + detail);
    }
    const block = (data.content || []).find(b => b.type === 'text');
    const text = block && typeof block.text === 'string' ? block.text.trim() : '';
    if (!text) throw new Error('AI-service gaf een leeg antwoord');
    return text;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('AI-service reageerde niet binnen 60 seconden');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function parseThemeAdvice(text, themeKeys) {
  const match = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI-antwoord kon niet gelezen worden');
  const parsed = JSON.parse(match[0]);
  const advice = {};
  themeKeys.forEach((theme, i) => {
    const value = parsed['THEMA_' + i];
    if (typeof value === 'string' && value.trim()) advice[theme] = value.trim();
  });
  if (!Object.keys(advice).length) throw new Error('AI-antwoord bevatte geen adviezen');
  return advice;
}

// ── REPORT GENERATION (server-side) ───────────────────────────────────
async function loadReportContext() {
  const [qs, kb, dims, themes] = await Promise.all([
    pool.query(`SELECT q.id, q.theme, q.text FROM questions q
                JOIN themes t ON q.theme = t.name
                LEFT JOIN dimensions d ON t.dimension = d.name
                WHERE q.active = TRUE
                ORDER BY ${QUESTION_ORDER}`),
    pool.query('SELECT title, content FROM knowledge_base ORDER BY created_at'),
    pool.query('SELECT name, description FROM dimensions ORDER BY sort_order'),
    pool.query(THEME_ORDER_QUERY)
  ]);
  return {
    questions: qs.rows.map(q => ({ id: q.id, theme: q.theme, text: q.text, active: true })),
    kbContext: kb.rows.map(k => k.title + ':\n' + k.content).join('\n\n'),
    dimensions: dims.rows.map(d => ({
      name: d.name,
      description: d.description || '',
      themes: themes.rows.filter(t => t.dimension === d.name).map(t => t.name)
    }))
  };
}

async function answersByParticipant(ids) {
  const map = {};
  ids.forEach(id => { map[id] = {}; });
  if (!ids.length) return map;
  const res = await pool.query(
    'SELECT participant_id, question_id, value FROM answers WHERE participant_id = ANY($1::text[])',
    [ids]
  );
  res.rows.forEach(r => { map[r.participant_id][r.question_id] = r.value; });
  return map;
}

// Raw 1-5 answers become a 1-10 score; qIndividual keeps the raw values because
// the report's spread bars are drawn from them.
function computeScores(questions, answerSets) {
  const qScores = {}, qIndividual = {}, tScores = {};
  questions.forEach(q => {
    const vals = answerSets.map(a => a[q.id]).filter(v => typeof v === 'number');
    if (!vals.length) return;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const s10 = Math.round((avg / 5 * 9 + 1) * 10) / 10;
    qScores[q.id] = s10;
    qIndividual[q.id] = vals;
    if (!tScores[q.theme]) tScores[q.theme] = [];
    tScores[q.theme].push(s10);
  });
  const tAvgs = {};
  Object.keys(tScores).forEach(t => {
    const arr = tScores[t];
    tAvgs[t] = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10;
  });
  const overallVals = Object.values(tAvgs);
  const overall = overallVals.length
    ? Math.round(overallVals.reduce((a, b) => a + b, 0) / overallVals.length * 10) / 10
    : 0;
  return { qScores, qIndividual, tAvgs, overall };
}

function themeScoreLines(themeKeys, tAvgs, qScores, questions) {
  return themeKeys.map((theme, i) => {
    const qs = questions
      .filter(q => q.theme === theme && qScores[q.id] !== undefined)
      .map(q => q.text + ' (' + qScores[q.id] + ')')
      .join('; ');
    return 'THEMA_' + i + ' [' + theme + '] (' + tAvgs[theme] + '/10): ' + qs;
  }).join('\n');
}

function teamAdvicePrompt(ctx, scores, teamName, orgName, count) {
  const themeKeys = Object.keys(scores.tAvgs);
  return 'Je bent expert in teamontwikkeling bij Team Shapers. Schrijf voor elk thema een kort lopend stukje advies in het Nederlands.\n\n' +
    'Schrijfstijl:\n' +
    '- Begin met een constatering in de wij-vorm die de teamdynamiek beschrijft. Geen cijfers of scores noemen.\n' +
    '- Sluit af met een concreet advies in algemene schrijfstijl ("Het is urgent om...", "Een goede stap is...", "Het loont om..."). Geen wij-vorm.\n' +
    '- Schrijf als één doorlopende alinea. Geen kopjes, geen nummers, geen labels.\n' +
    '- Maximaal 3 zinnen totaal.\n\n' +
    (ctx.kbContext ? 'Gebruik deze kennis van Team Shapers als context:\n' + ctx.kbContext + '\n\n' : '') +
    'Team: ' + teamName + ' (' + orgName + '), deelnemers: ' + count + '\n\n' +
    themeScoreLines(themeKeys, scores.tAvgs, scores.qScores, ctx.questions) + '\n\n' +
    'Geef ALLEEN een JSON object terug, geen markdown:\n' +
    '{' + themeKeys.map((t, i) => '"THEMA_' + i + '":"lopende alinea"').join(',') + '}';
}

function individualAdvicePrompt(ctx, scores, participantName, teamName) {
  const themeKeys = Object.keys(scores.tAvgs);
  return 'Je bent expert in teamontwikkeling bij Team Shapers. Genereer voor elk thema een persoonlijk advies in het Nederlands.\n\n' +
    'Structuur per thema:\n' +
    '1. Constatering (ik-vorm): wat zeggen de scores over deze persoon.\n' +
    '2. Advies van Team Shapers (algemene schrijfstijl, geen ik/wij): concreet handelingsperspectief.\n\n' +
    (ctx.kbContext ? 'Gebruik deze kennis van Team Shapers als context:\n' + ctx.kbContext + '\n\n' : '') +
    'Deelnemer: ' + participantName + ', team: ' + teamName + '\n\n' +
    themeScoreLines(themeKeys, scores.tAvgs, scores.qScores, ctx.questions) + '\n\n' +
    'Geef ALLEEN een JSON object terug, geen markdown:\n' +
    '{' + themeKeys.map((t, i) => '"THEMA_' + i + '":"advies"').join(',') + '}\n\n' +
    'Toon: >=7.5 positief, 6-7.4 groei, <6 urgent.';
}

async function saveReport(report) {
  await pool.query(
    `INSERT INTO reports (id, team_id, org_id, is_individual, participant_id, participant_name, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET
       data=$7, team_id=$2, org_id=$3, is_individual=$4,
       participant_id=$5, participant_name=$6, generated_at=NOW()`,
    [report.id, report.teamId || null, report.orgId || null, report.isIndividual || false,
     report.participantId || null, report.participantName || null, JSON.stringify(report)]
  );
}

// Returns { report, aiWarning } on success or { error, status } on failure.
// A failing AI call is a warning, not a failure: the scores are still worth saving.
async function generateTeamReport(teamId) {
  const teamRes = await pool.query(
    'SELECT t.id, t.name, t.org_id, o.name AS org_name FROM teams t JOIN organisations o ON t.org_id = o.id WHERE t.id = $1',
    [teamId]
  );
  if (!teamRes.rows.length) return { error: 'Team niet gevonden.', status: 404 };
  const team = teamRes.rows[0];

  const ps = await pool.query('SELECT id FROM participants WHERE team_id = $1 AND completed = TRUE', [teamId]);
  if (!ps.rows.length) return { error: 'Geen afgeronde deelnemers om een rapport van te genereren.', status: 400 };

  const ctx = await loadReportContext();
  const answerMap = await answersByParticipant(ps.rows.map(p => p.id));
  const scores = computeScores(ctx.questions, ps.rows.map(p => answerMap[p.id]));
  if (!Object.keys(scores.tAvgs).length) {
    return { error: 'Er zijn nog geen antwoorden om een rapport van te maken.', status: 400 };
  }

  const report = {
    id: teamId,
    teamId: teamId,
    orgId: team.org_id,
    isIndividual: false,
    qScores: scores.qScores,
    qIndividual: scores.qIndividual,
    tAvgs: scores.tAvgs,
    overall: scores.overall,
    questions: ctx.questions,
    dimensions: ctx.dimensions,
    aiAdvice: {},
    generatedAt: new Date().toISOString(),
    participantCount: ps.rows.length
  };

  let aiWarning = null;
  try {
    const text = await callClaude(teamAdvicePrompt(ctx, scores, team.name, team.org_name, ps.rows.length), 2000);
    report.aiAdvice = parseThemeAdvice(text, Object.keys(scores.tAvgs));
  } catch (e) {
    aiWarning = e.message;
    console.error('AI-advies teamrapport mislukt:', e.message);
  }

  await saveReport(report);
  return { report, aiWarning };
}

async function generateIndividualReport(participantId) {
  const pRes = await pool.query(
    `SELECT p.id, p.first_name, p.last_name, p.completed, t.id AS team_id, t.name AS team_name,
            t.org_id, o.name AS org_name
     FROM participants p
     JOIN teams t ON p.team_id = t.id
     JOIN organisations o ON t.org_id = o.id
     WHERE p.id = $1`,
    [participantId]
  );
  if (!pRes.rows.length) return { error: 'Deelnemer niet gevonden.', status: 404 };
  const p = pRes.rows[0];
  if (!p.completed) return { error: 'Deelnemer heeft de vragenlijst nog niet afgerond.', status: 400 };

  const participantName = [p.first_name, p.last_name].filter(Boolean).join(' ');
  const ctx = await loadReportContext();
  const answerMap = await answersByParticipant([participantId]);
  const scores = computeScores(ctx.questions, [answerMap[participantId]]);
  if (!Object.keys(scores.tAvgs).length) {
    return { error: 'Er zijn nog geen antwoorden om een rapport van te maken.', status: 400 };
  }

  const report = {
    id: 'individual_' + participantId,
    teamId: p.team_id,
    orgId: p.org_id,
    isIndividual: true,
    participantId: participantId,
    participantName: participantName,
    qScores: scores.qScores,
    qIndividual: scores.qIndividual,
    tAvgs: scores.tAvgs,
    overall: scores.overall,
    questions: ctx.questions,
    dimensions: ctx.dimensions,
    aiAdvice: {},
    generatedAt: new Date().toISOString(),
    participantCount: 1
  };

  let aiWarning = null;
  try {
    const text = await callClaude(individualAdvicePrompt(ctx, scores, participantName, p.team_name), 2000);
    report.aiAdvice = parseThemeAdvice(text, Object.keys(scores.tAvgs));
  } catch (e) {
    aiWarning = e.message;
    console.error('AI-advies individueel rapport mislukt:', e.message);
  }

  await saveReport(report);
  return { report, aiWarning };
}

// Fired after a participant completes. Never overwrites an existing report, so
// advice an admin has edited stays intact.
async function autoGenerateReports(participantId) {
  try {
    const individualId = 'individual_' + participantId;
    const existing = await pool.query('SELECT id FROM reports WHERE id = $1', [individualId]);
    if (!existing.rows.length) await generateIndividualReport(participantId);

    const pRes = await pool.query('SELECT team_id FROM participants WHERE id = $1', [participantId]);
    const teamId = pRes.rows.length ? pRes.rows[0].team_id : null;
    if (!teamId) return;

    const pending = await pool.query(
      'SELECT COUNT(*)::int AS c FROM participants WHERE team_id = $1 AND completed = FALSE',
      [teamId]
    );
    if (pending.rows[0].c > 0) return;

    const teamReport = await pool.query('SELECT id FROM reports WHERE id = $1', [teamId]);
    if (teamReport.rows.length) return;
    await generateTeamReport(teamId);
  } catch (e) {
    console.error('Automatische rapportgeneratie mislukt:', e.stack || e.message);
  }
}

// ── ADMIN: REPORTS ────────────────────────────────────────────────────
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reports ORDER BY generated_at DESC');
    // The full report object is stored in the `data` column. Return it at the top
    // level (with the metadata columns) so the frontend reads tAvgs/qScores/etc directly.
    const reports = result.rows.map(row => {
      const d = (row.data && typeof row.data === 'object') ? row.data : {};
      return Object.assign({}, d, {
        id: row.id,
        teamId: d.teamId || row.team_id || undefined,
        orgId: d.orgId || row.org_id || undefined,
        isIndividual: d.isIndividual || row.is_individual || false,
        participantId: d.participantId || row.participant_id || undefined,
        participantName: d.participantName || row.participant_name || undefined,
        generatedAt: d.generatedAt || row.generated_at
      });
    });
    res.json(reports);
  } catch (e) {
    fail(res, 500, 'Rapporten konden niet geladen worden.', e);
  }
});

app.post('/api/admin/reports/generate', adminAuth, async (req, res) => {
  try {
    const { type, teamId, participantId } = req.body || {};
    let result;
    if (type === 'individual') {
      if (!participantId) return res.status(400).json({ error: 'participantId ontbreekt' });
      result = await generateIndividualReport(participantId);
    } else {
      if (!teamId) return res.status(400).json({ error: 'teamId ontbreekt' });
      result = await generateTeamReport(teamId);
    }
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ report: result.report, aiWarning: result.aiWarning || null });
  } catch (e) {
    fail(res, 500, 'Rapport genereren is mislukt.', e);
  }
});

// Regenerate the advice for a single theme. The stored report is only touched
// once the AI call has actually produced text, so a failure can never wipe
// existing advice.
app.post('/api/admin/reports/:id/advice', adminAuth, async (req, res) => {
  try {
    const { theme, customPrompt } = req.body || {};
    if (!theme) return res.status(400).json({ error: 'Thema ontbreekt' });
    const stored = await pool.query('SELECT data FROM reports WHERE id = $1', [req.params.id]);
    if (!stored.rows.length) return res.status(404).json({ error: 'Rapport niet gevonden.' });

    const report = Object.assign({}, stored.rows[0].data, { id: req.params.id });
    const ctx = await loadReportContext();
    const questions = (Array.isArray(report.questions) && report.questions.length) ? report.questions : ctx.questions;
    const qLines = questions
      .filter(q => q.theme === theme)
      .map(q => '"' + q.text + '" (' + ((report.qScores || {})[q.id] || 0) + ')')
      .join(', ');

    const prompt = 'Je bent expert in teamontwikkeling bij Team Shapers. Genereer een concreet advies voor het thema "' + theme + '" in het Nederlands.\n\n' +
      (ctx.kbContext ? 'Gebruik deze kennis:\n' + ctx.kbContext + '\n\n' : '') +
      'Thema: ' + theme + ' (score: ' + ((report.tAvgs || {})[theme] || 0) + '/10)\nVragen: ' + qLines + '\n\n' +
      (customPrompt ? 'Aanvullende instructie: ' + String(customPrompt).slice(0, 1000) + '\n\n' : '') +
      'Geef ALLEEN de adviestekst terug (geen JSON, geen headers), 2-4 zinnen in wij-vorm.';

    const text = await callClaude(prompt, 500);
    report.aiAdvice = Object.assign({}, report.aiAdvice, { [theme]: text });
    await saveReport(report);
    res.json({ advice: text });
  } catch (e) {
    fail(res, 502, e.message || 'Advies genereren is mislukt.', e);
  }
});

app.post('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    // Used by the report editor to persist manually edited advice.
    const r = req.body || {};
    if (!r.id) return res.status(400).json({ error: 'id ontbreekt' });
    await saveReport(r);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Rapport opslaan is mislukt.', e);
  }
});

app.delete('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Rapport verwijderen is mislukt.', e);
  }
});

// ── ADMIN: KNOWLEDGE BASE ─────────────────────────────────────────────
app.get('/api/admin/knowledge', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM knowledge_base ORDER BY created_at');
    res.json(result.rows);
  } catch (e) {
    fail(res, 500, 'Kennisbank kon niet geladen worden.', e);
  }
});

app.post('/api/admin/knowledge', adminAuth, async (req, res) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: 'Titel en inhoud zijn verplicht.' });
    const id = uid();
    await pool.query('INSERT INTO knowledge_base (id, title, content) VALUES ($1,$2,$3)', [id, title, content]);
    res.json({ id, title, content });
  } catch (e) {
    fail(res, 500, 'Kennisbank-item toevoegen is mislukt.', e);
  }
});

app.delete('/api/admin/knowledge/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_base WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    fail(res, 500, 'Kennisbank-item verwijderen is mislukt.', e);
  }
});

// ── SHARED REPORTS ────────────────────────────────────────────────────
// The share snapshot is built server-side from the stored report, so the client
// cannot dictate what a share link contains. The token is generated here too.
app.post('/api/admin/shared-reports', adminAuth, async (req, res) => {
  try {
    const { reportId, password } = req.body || {};
    if (!reportId) return res.status(400).json({ error: 'reportId ontbreekt' });
    if (!password || String(password).length < 4) {
      return res.status(400).json({ error: 'Kies een wachtwoord van minimaal 4 tekens.' });
    }
    const stored = await pool.query('SELECT data FROM reports WHERE id = $1', [reportId]);
    if (!stored.rows.length) return res.status(404).json({ error: 'Rapport niet gevonden.' });
    const report = stored.rows[0].data || {};

    let orgName = '', teamName = '';
    if (report.teamId) {
      const t = await pool.query(
        'SELECT t.name, o.name AS org_name FROM teams t JOIN organisations o ON t.org_id = o.id WHERE t.id = $1',
        [report.teamId]
      );
      if (t.rows.length) { teamName = t.rows[0].name; orgName = t.rows[0].org_name; }
    }
    if (report.isIndividual) teamName = (report.participantName || 'Deelnemer') + ' (individueel)';

    const snapshot = { org: { name: orgName }, team: { name: teamName }, report: report };
    const token = crypto.randomBytes(24).toString('base64url');
    const passwordHash = await bcrypt.hash(String(password), 10);
    await pool.query(
      'INSERT INTO shared_reports (token, report_id, password_hash, data) VALUES ($1, $2, $3, $4)',
      [token, reportId, passwordHash, JSON.stringify(snapshot)]
    );
    res.json({ token });
  } catch (e) {
    fail(res, 500, 'Deellink aanmaken is mislukt.', e);
  }
});

// POST, not GET: a password does not belong in a URL (logs, history, referrers).
app.post('/api/reports/shared/:token', async (req, res) => {
  try {
    if (!rateLimit('share:' + req.ip, 30, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Te veel pogingen. Probeer het later opnieuw.' });
    }
    const result = await pool.query(
      `SELECT sr.password_hash, sr.data, r.data AS legacy_data
       FROM shared_reports sr
       LEFT JOIN reports r ON sr.report_id = r.id
       WHERE sr.token = $1`,
      [req.params.token]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rapport niet gevonden' });
    const row = result.rows[0];
    if (row.password_hash) {
      const ok = await bcrypt.compare(String((req.body || {}).password || ''), row.password_hash);
      if (!ok) return res.status(401).json({ error: 'Wachtwoord onjuist', passwordRequired: true });
    }
    res.json({ data: row.data || row.legacy_data });
  } catch (e) {
    fail(res, 500, 'Rapport kon niet geladen worden.', e);
  }
});

// ── CATCH-ALL: serve index.html ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Last-resort guards: log unexpected errors instead of letting a single
// stray exception/rejection take the whole server down.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// ── START ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
