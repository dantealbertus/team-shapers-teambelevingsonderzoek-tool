require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── DATABASE ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
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
  `);

  const existing = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('admin_password', $1) ON CONFLICT DO NOTHING",
      [JSON.stringify(hash)]
    );
  }

  console.log('Database initialised');
}

// ── HELPERS ───────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function genCode() {
  return 'TBQ-' + Math.random().toString(36).slice(2, 10).toUpperCase().slice(0, 6);
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== (process.env.ADMIN_SESSION_TOKEN || 'dev-token')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── AUTH ENDPOINTS ────────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
    if (username !== expectedUsername) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
    const result = await pool.query("SELECT value FROM settings WHERE key = 'admin_password'");
    const hash = result.rows[0].value;
    const ok = await bcrypt.compare(password, hash);
    if (!ok) return res.status(401).json({ error: 'Onjuiste inloggegevens' });
    res.json({ token: process.env.ADMIN_SESSION_TOKEN || 'dev-token' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/participant/login', async (req, res) => {
  try {
    const { code } = req.body;
    const result = await pool.query(
      `SELECT p.*, t.name as team_name, t.id as team_id, o.name as org_name
       FROM participants p
       JOIN teams t ON p.team_id = t.id
       JOIN organisations o ON t.org_id = o.id
       WHERE p.code = $1`, [code.trim().toUpperCase()]
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
    res.status(500).json({ error: e.message });
  }
});

// ── QUESTIONS & THEMES (public) ───────────────────────────────────────
app.get('/api/questions', async (req, res) => {
  try {
    const qs = await pool.query(
      `SELECT q.* FROM questions q
       JOIN themes t ON q.theme = t.name
       WHERE q.active = TRUE
       ORDER BY t.sort_order, q.sort_order, q.created_at`
    );
    const themes = await pool.query('SELECT name FROM themes ORDER BY sort_order');
    res.json({
      questions: qs.rows.map(q => ({ id: q.id, theme: q.theme, text: q.text, active: q.active })),
      themes: themes.rows.map(t => t.name)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANSWERS ───────────────────────────────────────────────────────────
app.post('/api/answers', async (req, res) => {
  try {
    const { participantId, answers } = req.body;
    for (const [qid, val] of Object.entries(answers)) {
      await pool.query(
        `INSERT INTO answers (participant_id, question_id, value)
         VALUES ($1, $2, $3)
         ON CONFLICT (participant_id, question_id) DO UPDATE SET value = $3`,
        [participantId, qid, val]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/answers/complete', async (req, res) => {
  try {
    const { participantId } = req.body;
    await pool.query(
      'UPDATE participants SET completed = TRUE, completed_at = NOW() WHERE id = $1',
      [participantId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
            answerCount: countMap[p.id] || 0
          }))
        }))
    }));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/organisations', adminAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const id = uid();
    await pool.query('INSERT INTO organisations (id, name) VALUES ($1, $2)', [id, name]);
    res.json({ id, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/organisations/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM organisations WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/teams', adminAuth, async (req, res) => {
  try {
    const { orgId, name } = req.body;
    const id = uid();
    await pool.query('INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3)', [id, orgId, name]);
    res.json({ id, orgId, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/teams/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM teams WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/participants', adminAuth, async (req, res) => {
  try {
    const { teamId, firstName, lastName, email } = req.body;
    const id = uid();
    const code = genCode();
    await pool.query(
      'INSERT INTO participants (id, team_id, first_name, last_name, email, code) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, teamId, firstName, lastName || null, email || null, code]
    );
    res.json({ id, teamId, firstName, lastName, code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/participants/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM participants WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: QUESTIONS ─────────────────────────────────────────────────
app.get('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    const qs = await pool.query(
      `SELECT q.* FROM questions q
       JOIN themes t ON q.theme = t.name
       ORDER BY t.sort_order, q.sort_order, q.created_at`
    );
    const themes = await pool.query('SELECT name FROM themes ORDER BY sort_order');
    res.json({
      questions: qs.rows,
      themes: themes.rows.map(t => t.name)
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/questions', adminAuth, async (req, res) => {
  try {
    const { theme, text } = req.body;
    const id = uid();
    const max = await pool.query('SELECT COALESCE(MAX(sort_order),0) as m FROM questions WHERE theme=$1',[theme]);
    await pool.query(
      'INSERT INTO questions (id, theme, text, sort_order) VALUES ($1,$2,$3,$4)',
      [id, theme, text, (max.rows[0].m || 0) + 1]
    );
    res.json({ id, theme, text, active: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/questions/reorder', adminAuth, async (req, res) => {
  try {
    const { order } = req.body;
    for (const item of order) {
      await pool.query(
        'UPDATE questions SET sort_order=$1, theme=$2 WHERE id=$3',
        [item.sortOrder, item.theme, item.id]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    const { theme, text, active } = req.body;
    await pool.query(
      'UPDATE questions SET theme=$1, text=$2, active=$3 WHERE id=$4',
      [theme, text, active, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/questions/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM questions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/themes', adminAuth, async (req, res) => {
  try {
    const { name } = req.body;
    const max = await pool.query('SELECT COALESCE(MAX(sort_order),0) as m FROM themes');
    await pool.query(
      'INSERT INTO themes (name, sort_order) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [name, (max.rows[0].m || 0) + 1]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/themes/:name', adminAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    await pool.query('DELETE FROM themes WHERE name = $1', [name]);
    await pool.query('DELETE FROM questions WHERE theme = $1', [name]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// ── AI PROXY (server-side, keeps API key secret) ──────────────────────
app.post('/api/ai/advice', async (req, res) => {
  try {
    const { prompt, max_tokens } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: max_tokens || 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: REPORTS ────────────────────────────────────────────────────
app.get('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM reports ORDER BY generated_at DESC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reports', adminAuth, async (req, res) => {
  try {
    const { id, teamId, orgId, isIndividual, participantId, participantName, data } = req.body;
    await pool.query(
      `INSERT INTO reports (id, team_id, org_id, is_individual, participant_id, participant_name, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET data=$7, generated_at=NOW()`,
      [id, teamId, orgId, isIndividual || false, participantId || null, participantName || null, JSON.stringify(data)]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/reports/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN: KNOWLEDGE BASE ─────────────────────────────────────────────
app.get('/api/admin/knowledge', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM knowledge_base ORDER BY created_at');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/knowledge', adminAuth, async (req, res) => {
  try {
    const { title, content } = req.body;
    const id = uid();
    await pool.query('INSERT INTO knowledge_base (id, title, content) VALUES ($1,$2,$3)', [id, title, content]);
    res.json({ id, title, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/knowledge/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_base WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SHARED REPORTS (create)
app.post('/api/shared-reports', async (req, res) => {
  try {
    const { token, password, reportData } = req.body;
    const reportId = Math.random().toString(36).slice(2, 10).toUpperCase();
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO reports (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data=$2`,
      [reportId, JSON.stringify(reportData)]
    );
    await pool.query(
      `INSERT INTO shared_reports (token, report_id, password_hash) VALUES ($1, $2, $3) ON CONFLICT (token) DO UPDATE SET report_id=$2, password_hash=$3`,
      [token, reportId, passwordHash]
    );
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SHARED REPORTS ────────────────────────────────────────────────────
app.get('/api/reports/shared/:token', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT sr.*, r.data FROM shared_reports sr JOIN reports r ON sr.report_id = r.id WHERE sr.token = $1',
      [req.params.token]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    if (row.password_hash) {
      const pwd = req.query.pwd || '';
      const ok = await bcrypt.compare(pwd, row.password_hash);
      if (!ok) return res.status(401).json({ error: 'Wachtwoord onjuist', passwordRequired: true });
    }
    res.json({ data: row.data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CATCH-ALL: serve index.html ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── START ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialise database:', err);
  process.exit(1);
});
