/* =====================================================================
   BTP-Vision — BACKEND, zéro dépendance (Node 22.13 ou plus récent)
   Ce qu'il fait :
     1) sert la page web (dossier /public)
     2) stocke les données du projet (base SQLite) avec protection anti-écrasement
     3) gère des COMPTES séparés (un par intervenant) avec rôles
     4) stocke les photos (data/uploads) + leurs descriptions
     5) stocke les 3 durées (optimiste / probable / pessimiste) de chaque tâche
        et lance la simulation de Monte Carlo (pert.js)
   Lancer :  node server.js   puis ouvrir http://localhost:3000
   ===================================================================== */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { runMonteCarlo, pertStats } = require('./pert.js');   // moteur probabiliste

/* ---- 1. RÉGLAGES (modifiables par variables d'environnement) ---- */
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');   // base + photos
const MAX_BODY = 8 * 1024 * 1024;                                    // requêtes max 8 Mo
const SESSION_DAYS = 30;                                             // durée d'une connexion
fs.mkdirSync(path.join(DATA, 'uploads'), { recursive: true });

/* Rôles = tous les intervenants d'un chantier. 'lecteur' = lecture seule. */
const ROLES = ['admin', 'maitre_ouvrage', 'maitre_oeuvre', 'bet', 'controle', 'conducteur',
  'chef_chantier', 'entreprise', 'fournisseur', 'lecteur'];

/* ---- 2. BASE DE DONNÉES ---- */
const db = new DatabaseSync(path.join(DATA, 'btp.db'));
db.exec(`
 CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, updated_at TEXT);
 CREATE TABLE IF NOT EXISTS attachments(
   id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL,
   file TEXT NOT NULL, mime TEXT, size INTEGER, description TEXT,
   created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE INDEX IF NOT EXISTS ix_owner ON attachments(owner_type, owner_id);
 CREATE TABLE IF NOT EXISTS estimates (
   task_id TEXT PRIMARY KEY,
   optimistic REAL NOT NULL,
   probable   REAL NOT NULL,
   pessimistic REAL NOT NULL,
   updated_at TEXT DEFAULT (datetime('now'))
 );
 CREATE TABLE IF NOT EXISTS users(
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   username TEXT NOT NULL UNIQUE COLLATE NOCASE,
   name TEXT NOT NULL, role TEXT NOT NULL,
   salt TEXT NOT NULL, hash TEXT NOT NULL,
   created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS sessions(
   token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`);
// Mises à jour de la base pour les anciennes installations (ignorées si les colonnes existent déjà)
for (const sql of [
  'ALTER TABLE state ADD COLUMN version INTEGER NOT NULL DEFAULT 0',   // n° de version anti-écrasement
  'ALTER TABLE state ADD COLUMN updated_by TEXT',
  'ALTER TABLE estimates ADD COLUMN updated_by TEXT',
]) { try { db.exec(sql); } catch (e) { /* colonne déjà là */ } }

/* ---- 3. PETITS OUTILS ---- */
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = req => new Promise((ok, fail) => {
  let size = 0; const parts = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { fail(new Error('requête trop grande')); req.destroy(); } else parts.push(c); });
  req.on('end', () => ok(Buffer.concat(parts).toString()));
  req.on('error', fail);
});
const readJsonBody = async req => JSON.parse((await readBody(req)) || '{}');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const serveFile = (res, file, cache) => {
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'introuvable' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': cache ? 'private, max-age=31536000, immutable' : 'no-cache' });
    res.end(buf);
  });
};
// Vérifie le VRAI type du fichier d'après ses premiers octets
const sniff = b => b[0] === 0xFF && b[1] === 0xD8 ? ['jpg', 'image/jpeg']
  : b[0] === 0x89 && b[1] === 0x50 ? ['png', 'image/png']
  : b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' ? ['webp', 'image/webp'] : null;

/* ---- 4. COMPTES ET CONNEXIONS ---- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');   // mot de passe jamais stocké en clair
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });

function checkPw(user, pw) {
  const a = Buffer.from(hashPw(pw, user.salt), 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function addUser(username, name, role, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return db.prepare('INSERT INTO users(username,name,role,salt,hash) VALUES(?,?,?,?,?)')
    .run(username, name, role, salt, hashPw(pw, salt));
}
const cookieOf = (req, key) => (req.headers.cookie || '').split(';').map(s => s.trim().split('='))
  .find(([k]) => k === key)?.[1];
// Retrouve l'utilisateur connecté grâce au cookie de session
function currentUser(req) {
  const tok = cookieOf(req, 'sid');
  if (!tok) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                          WHERE s.token_hash=? AND s.expires_at>?`).get(sha(tok), Date.now());
  return row || null;
}
function startSession(req, res, userId, body) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());   // ménage
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
    .run(sha(tok), userId, Date.now() + SESSION_DAYS * 864e5);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  send(res, 200, body, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}` });
}
// Anti-force-brute : 5 erreurs de mot de passe => blocage 60 s
const fails = new Map();
const locked = k => (fails.get(k)?.until || 0) > Date.now();
const failed = k => { const f = fails.get(k) || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails.set(k, f); };

/* ---- 5. SIMULATION : tâches + 3 durées + état (tâche faite ou non) ---- */
function buildSimulationInput(remainingOnly) {
  const row = db.prepare('SELECT json FROM state WHERE id=1').get();
  const S = row ? JSON.parse(row.json) : null;
  if (!S || !S.phases) return null;
  const est = new Map(db.prepare('SELECT * FROM estimates').all().map(r => [r.task_id, r]));
  const tasks = [], missing = [];
  S.phases.forEach((ph, i) => (ph.tasks || []).forEach(t => {
    if (remainingOnly && t.d) return;                    // tâche déjà terminée : plus d'incertitude
    const e = est.get(t.id);
    if (!e) return missing.push({ id: t.id, label: t.t, phase: ph.name });
    tasks.push({ id: t.id, label: t.t, phase: ph.name, phaseIndex: i, o: e.optimistic, m: e.probable, p: e.pessimistic });
  }));
  return { tasks, missing };
}

/* ---- 6. LE SERVEUR ---- */
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, method = req.method;

    if (p === '/api/health') return send(res, 200, { ok: true });

    /* --- Accès public : état de la session, première configuration, connexion --- */
    if (p === '/api/session' && method === 'GET') {
      const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
      const u = currentUser(req);
      return send(res, 200, { user: u ? publicUser(u) : null, needsSetup: n === 0, roles: ROLES });
    }
    if (p === '/api/setup' && method === 'POST') {            // crée le 1er compte (admin), une seule fois
      if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return send(res, 403, { error: 'déjà configuré' });
      const b = await readJsonBody(req);
      const username = String(b.username || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!username || !name || pw.length < 6) return send(res, 400, { error: 'Nom, identifiant et mot de passe (6 caractères min.) requis' });
      const r = addUser(username, name, 'admin', pw);
      return startSession(req, res, Number(r.lastInsertRowid), { ok: true });
    }
    if (p === '/api/login' && method === 'POST') {
      const b = await readJsonBody(req);
      const key = String(b.username || '').toLowerCase() + '|' + req.socket.remoteAddress;
      if (locked(key)) return send(res, 429, { error: 'Trop d\'essais, réessayez dans 1 minute' });
      const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(b.username || '').trim());
      if (!u || !checkPw(u, String(b.password || ''))) { failed(key); return send(res, 401, { error: 'Identifiant ou mot de passe incorrect' }); }
      fails.delete(key);
      return startSession(req, res, u.id, { ok: true });
    }

    /* --- Page web (publique : elle ne contient aucune donnée, seulement l'écran de connexion) --- */
    if (method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/uploads/')) {
      const rel = p === '/' ? 'index.html' : path.basename(p);
      return serveFile(res, path.join(__dirname, 'public', rel), false);
    }

    /* --- Tout le reste exige un compte connecté --- */
    const me = currentUser(req);
    if (!me) return send(res, 401, { error: 'Connexion requise' });
    const canWrite = me.role !== 'lecteur';
    const isAdmin = me.role === 'admin';
    if (method !== 'GET' && p !== '/api/logout' && p !== '/api/me/password' && !canWrite)
      return send(res, 403, { error: 'Votre compte est en lecture seule' });

    if (p === '/api/logout' && method === 'POST') {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha(cookieOf(req, 'sid')));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
    }
    if (p === '/api/me/password' && method === 'PUT') {
      const b = await readJsonBody(req);
      if (!checkPw(me, String(b.old || ''))) return send(res, 400, { error: 'Ancien mot de passe incorrect' });
      if (String(b.password || '').length < 6) return send(res, 400, { error: 'Mot de passe : 6 caractères minimum' });
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(String(b.password), salt), me.id);
      return send(res, 200, { ok: true });
    }

    /* --- Gestion des comptes (administrateur seulement) --- */
    if (p.startsWith('/api/users')) {
      if (!isAdmin) return send(res, 403, { error: 'Réservé à l\'administrateur' });
      if (p === '/api/users' && method === 'GET')
        return send(res, 200, db.prepare('SELECT id,username,name,role,created_at FROM users ORDER BY id').all());
      if (p === '/api/users' && method === 'POST') {
        const b = await readJsonBody(req);
        const username = String(b.username || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
        if (!username || !name || pw.length < 6 || !ROLES.includes(b.role))
          return send(res, 400, { error: 'Nom, identifiant, rôle et mot de passe (6 caractères min.) requis' });
        try { addUser(username, name, b.role, pw); } catch (e) { return send(res, 409, { error: 'Cet identifiant existe déjà' }); }
        return send(res, 201, { ok: true });
      }
      const id = Number(p.split('/')[3]);
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!target) return send(res, 404, { error: 'introuvable' });
      if (method === 'DELETE') {
        if (target.id === me.id) return send(res, 400, { error: 'Vous ne pouvez pas supprimer votre propre compte' });
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        db.prepare('DELETE FROM users WHERE id=?').run(id);
        return send(res, 200, { ok: true });
      }
      if (method === 'PUT') {                                   // réinitialiser le mot de passe / changer le rôle
        const b = await readJsonBody(req);
        if (b.password) {
          if (String(b.password).length < 6) return send(res, 400, { error: 'Mot de passe : 6 caractères minimum' });
          const salt = crypto.randomBytes(16).toString('hex');
          db.prepare('UPDATE users SET salt=?, hash=? WHERE id=?').run(salt, hashPw(String(b.password), salt), id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);   // déconnecte l'intéressé
        }
        if (b.role) {
          if (!ROLES.includes(b.role)) return send(res, 400, { error: 'rôle inconnu' });
          if (target.id === me.id && b.role !== 'admin') return send(res, 400, { error: 'Vous ne pouvez pas retirer votre propre rôle admin' });
          db.prepare('UPDATE users SET role=? WHERE id=?').run(b.role, id);
        }
        return send(res, 200, { ok: true });
      }
    }

    /* --- Données du projet, AVEC PROTECTION ANTI-ÉCRASEMENT ---
       Chaque enregistrement porte un n° de version. Le client envoie la version qu'il a vue (baseVersion).
       Si quelqu'un d'autre a enregistré entre-temps => 409 + les données actuelles, et le client FUSIONNE
       au lieu d'écraser. Node traite une requête à la fois (SQLite synchrone) : le test est donc atomique. */
    if (p === '/api/state') {
      if (method === 'GET') {
        const row = db.prepare('SELECT json, version, updated_by FROM state WHERE id=1').get();
        const version = row ? row.version : 0;
        if (url.searchParams.get('since') === String(version)) return send(res, 200, { version, unchanged: true });
        return send(res, 200, { json: row ? row.json : null, version, updatedBy: row?.updated_by || null });
      }
      if (method === 'PUT') {
        const b = await readJsonBody(req);
        JSON.parse(b.json);                                              // doit être du JSON valide, sinon 400
        const row = db.prepare('SELECT json, version FROM state WHERE id=1').get();
        const current = row ? row.version : 0;
        if (Number(b.baseVersion) !== current)
          return send(res, 409, { error: 'conflit', json: row ? row.json : null, version: current });
        const next = current + 1;
        db.prepare(`INSERT INTO state(id,json,updated_at,version,updated_by) VALUES(1,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at,
                    version=excluded.version, updated_by=excluded.updated_by`)
          .run(b.json, new Date().toISOString(), next, me.name);
        return send(res, 200, { ok: true, version: next });
      }
    }

    /* --- Photos --- */
    if (p === '/api/attachments' && method === 'GET') {
      const rows = db.prepare('SELECT id,file,description,created_at FROM attachments WHERE owner_type=? AND owner_id=? ORDER BY created_at')
        .all(url.searchParams.get('ownerType') || '', url.searchParams.get('ownerId') || '');
      return send(res, 200, rows);
    }
    if (p === '/api/attachments' && method === 'POST') {
      const b = await readJsonBody(req);
      const m = /^data:image\/[a-z]+;base64,(.+)$/.exec(b.dataUrl || '');
      if (!m || !b.ownerType || !b.ownerId) return send(res, 400, { error: 'requête invalide' });
      const buf = Buffer.from(m[1], 'base64');
      const kind = sniff(buf);
      if (!kind) return send(res, 415, { error: 'images uniquement (jpg, png, webp)' });
      const id = crypto.randomUUID(), file = `${id}.${kind[0]}`;
      fs.writeFileSync(path.join(DATA, 'uploads', file), buf);
      db.prepare('INSERT INTO attachments(id,owner_type,owner_id,file,mime,size,description) VALUES(?,?,?,?,?,?,?)')
        .run(id, String(b.ownerType), String(b.ownerId), file, kind[1], buf.length, String(b.description || '').slice(0, 500));
      return send(res, 201, { id, file });
    }
    if (p.startsWith('/api/attachments/') && method === 'DELETE') {
      const id = p.split('/').pop();
      const row = db.prepare('SELECT file FROM attachments WHERE id=?').get(id);
      if (!row) return send(res, 404, { error: 'introuvable' });
      fs.rmSync(path.join(DATA, 'uploads', path.basename(row.file)), { force: true });
      db.prepare('DELETE FROM attachments WHERE id=?').run(id);
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/uploads/') && method === 'GET')              // photos : maintenant réservées aux comptes connectés
      return serveFile(res, path.join(DATA, 'uploads', path.basename(p)), true);

    /* --- Estimations PERT : liste de toutes les tâches --- */
    if (p === '/api/estimates' && method === 'GET') {
      const out = {};
      for (const r of db.prepare('SELECT * FROM estimates').all())
        out[r.task_id] = { o: r.optimistic, m: r.probable, p: r.pessimistic, by: r.updated_by, at: r.updated_at };
      return send(res, 200, out);
    }

    /* --- a) Enregistrer les 3 durées d'une tâche --- PUT /api/estimates/:taskId  body: { optimistic, probable, pessimistic } */
    if (method === 'PUT' && p.startsWith('/api/estimates/')) {
      const taskId = decodeURIComponent(p.split('/').pop());
      const { optimistic, probable, pessimistic } = await readJsonBody(req);
      const ok = [optimistic, probable, pessimistic].every(x => typeof x === 'number' && isFinite(x) && x >= 0);
      if (!ok || !(optimistic <= probable && probable <= pessimistic))
        return send(res, 400, { error: 'Durées invalides : il faut optimiste ≤ probable ≤ pessimiste (nombres positifs)' });
      db.prepare(`
        INSERT INTO estimates (task_id, optimistic, probable, pessimistic, updated_at, updated_by)
        VALUES (?, ?, ?, ?, datetime('now'), ?)
        ON CONFLICT(task_id) DO UPDATE SET
          optimistic = excluded.optimistic,
          probable = excluded.probable,
          pessimistic = excluded.pessimistic,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(taskId, optimistic, probable, pessimistic, me.name);
      return send(res, 200, { ok: true });
    }

    /* --- b) Lancer la simulation --- GET /api/simulation?target=15&remaining=1 */
    if (method === 'GET' && p === '/api/simulation') {
      const remainingOnly = url.searchParams.get('remaining') !== '0';   // par défaut : seulement les tâches restantes
      const tq = parseFloat(url.searchParams.get('target'));
      const input = buildSimulationInput(remainingOnly);
      if (!input) return send(res, 200, { error: 'Aucun projet créé pour le moment.' });
      if (input.tasks.length === 0)
        return send(res, 200, { error: input.missing.length
          ? `Aucune estimation enregistrée pour les ${input.missing.length} tâche(s) concernée(s). Ouvrez une phase et cliquez sur ⏱ à côté d'une tâche.`
          : 'Aucune tâche restante : le chantier est terminé.' });
      const result = runMonteCarlo(input.tasks, 5000, isFinite(tq) ? tq : null);
      const total = result.sd * result.sd || 1;
      result.tasks = input.tasks.map(t => {
        const s = pertStats(t.o, t.m, t.p);
        return { id: t.id, label: t.label, phase: t.phase, o: t.o, m: t.m, p: t.p, mean: s.mean, sd: s.sd, share: s.variance / total };
      }).sort((a, b) => b.share - a.share);
      result.missing = input.missing;
      result.remainingOnly = remainingOnly;
      return send(res, 200, result);
    }

    send(res, 404, { error: 'introuvable' });
  } catch (e) {
    send(res, 400, { error: e.message });                          // toute erreur de saisie s'arrête ici, le serveur continue
  }
}).listen(PORT, () => console.log(`BTP-Vision tourne sur http://localhost:${PORT}`));
