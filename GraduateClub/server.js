const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) return;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  });
}

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const HTML_FILE = path.join(__dirname, 'graduates-club.html');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'registrations.json');
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_secret_')
);
const sessions = new Map();

if (!ADMIN_PASSWORD) {
  throw new Error('Missing required ADMIN_PASSWORD environment variable');
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function readRegistrations() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (_) { return []; }
}

function writeRegistrations(entries) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function getRegistrations() {
  if (!USE_SUPABASE) return readRegistrations();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/registrations?select=*&order=submitted_at.desc`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase read failed: ${response.status}`);
  return (await response.json()).map(row => ({
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    college: row.college,
    majorAr: row.major_ar,
    majorEn: row.major_en,
    year: row.year,
    yearLabelAr: row.year_label_ar,
    yearLabelEn: row.year_label_en,
    sectionAr: row.section_ar,
    sectionEn: row.section_en,
    submittedAt: row.submitted_at
  }));
}

async function addRegistration(entry) {
  if (!USE_SUPABASE) {
    const entries = readRegistrations();
    entries.push(entry);
    writeRegistrations(entries);
    return entry;
  }
  const row = {
    id: entry.id,
    full_name: entry.fullName,
    phone: entry.phone,
    college: entry.college,
    major_ar: entry.majorAr,
    major_en: entry.majorEn,
    year: entry.year,
    year_label_ar: entry.yearLabelAr,
    year_label_en: entry.yearLabelEn,
    section_ar: entry.sectionAr,
    section_en: entry.sectionEn,
    submitted_at: entry.submittedAt
  };
  const response = await fetch(`${SUPABASE_URL}/rest/v1/registrations`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify(row)
  });
  if (!response.ok) throw new Error(`Supabase insert failed: ${response.status}`);
  return entry;
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt < Date.now()) { sessions.delete(token); return false; }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/graduates-club.html')) {
      return send(res, 200, fs.readFileSync(HTML_FILE), 'text/html; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      const { password } = await readBody(req);
      const supplied = Buffer.from(String(password || ''));
      const expected = Buffer.from(ADMIN_PASSWORD);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected))
        return send(res, 401, { error: 'Invalid credentials' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);
      return send(res, 200, { token });
    }

    if (req.method === 'GET' && url.pathname === '/api/registrations') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Unauthorized' });
      return send(res, 200, await getRegistrations());
    }

    if (req.method === 'POST' && url.pathname === '/api/registrations') {
      const entry = await readBody(req);
      const required = ['fullName', 'phone', 'college', 'majorAr', 'majorEn', 'sectionAr', 'sectionEn'];
      const isArchitecture = entry.college === 'engineering' && entry.majorEn === 'Architecture Program';
      if (entry.year !== 'final' && entry.year !== (isArchitecture ? '4' : '3'))
        return send(res, 403, { error: 'Registration is open to juniors and seniors across all majors.' });
      if (required.some(key => !String(entry[key] || '').trim()))
        return send(res, 400, { error: 'Missing required fields' });

      const cleanEntry = {
        ...entry,
        id: 'GC-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(2).toString('hex').toUpperCase(),
        fullName: String(entry.fullName).trim().slice(0, 120),
        phone: String(entry.phone).trim().slice(0, 30),
        year: entry.year,
        submittedAt: new Date().toISOString()
      };
      return send(res, 201, await addRegistration(cleanEntry));
    }

    send(res, 404, { error: 'Not found' });
  } catch (error) {
    send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Graduate Club: http://localhost:${PORT}`);
  console.log(`Registration storage: ${USE_SUPABASE ? 'Supabase' : 'local JSON (development fallback)'}`);
});
