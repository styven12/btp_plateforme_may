/* =====================================================================
   BTP-Vision — BACKEND (Node 22.13 ou plus récent)
   Ce qu'il fait :
     1) sert la page web (dossier /public)
     2) stocke les données du projet dans MySQL avec protection anti-écrasement
     3) gère des COMPTES séparés (un par intervenant) avec rôles
     4) stocke les photos et leurs descriptions dans MySQL
     5) stocke les 3 durées (optimiste / probable / pessimiste) de chaque tâche
        et lance la simulation de Monte Carlo (pert.js)
   Lancer :  node server.js   puis ouvrir http://localhost:3000
   ===================================================================== */
require('dotenv').config();

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');
const { runMonteCarlo, pertStats } = require('./pert.js');   // moteur probabiliste

/* ---- 1. RÉGLAGES (modifiables par variables d'environnement) ---- */
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 8 * 1024 * 1024;                                    // requêtes max 8 Mo
const SESSION_DAYS = 30;                                             // durée d'une connexion

function mysqlConfig() {
  const databaseUrl = process.env.DATABASE_URL;
  const connectionString = process.env.MYSQL_URL ||
    (databaseUrl && ['mysql:', 'mysqls:'].includes(new URL(databaseUrl).protocol) ? databaseUrl : null);
  if (connectionString) {
    const url = new URL(connectionString);
    if (!['mysql:', 'mysqls:'].includes(url.protocol)) throw new Error('MYSQL_URL doit utiliser mysql:// ou mysqls://');
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ...(url.protocol === 'mysqls:' || process.env.MYSQL_SSL === 'true'
        ? { ssl: { rejectUnauthorized: true } } : {})
    };
  }
  const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE)
    throw new Error('Configurez MYSQL_URL ou MYSQL_HOST, MYSQL_USER et MYSQL_DATABASE.');
  return {
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT || 3306),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD || '',
    database: MYSQL_DATABASE,
    ...(process.env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {})
  };
}

/* Rôles = tous les intervenants d'un chantier. 'lecteur' = lecture seule. */
const ROLES = ['admin', 'maitre_ouvrage', 'maitre_oeuvre', 'bet', 'controle', 'conducteur',
  'chef_chantier', 'entreprise', 'fournisseur', 'lecteur'];

/* ---- 2. BASE DE DONNÉES ---- */
const db = mysql.createPool({
  ...mysqlConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});
async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS state (
      id TINYINT PRIMARY KEY,
      json LONGTEXT NULL,
      updated_at DATETIME NULL,
      version BIGINT UNSIGNED NOT NULL DEFAULT 0,
      updated_by VARCHAR(255) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id CHAR(36) PRIMARY KEY,
      owner_type VARCHAR(100) NOT NULL,
      owner_id VARCHAR(191) NOT NULL,
      file VARCHAR(64) NOT NULL,
      mime VARCHAR(100) NOT NULL,
      size INT UNSIGNED NOT NULL,
      data MEDIUMBLOB NOT NULL,
      description VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX ix_owner (owner_type, owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS estimates (
      task_id VARCHAR(191) PRIMARY KEY,
      optimistic DOUBLE NOT NULL,
      probable DOUBLE NOT NULL,
      pessimistic DOUBLE NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by VARCHAR(255) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(191) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL,
      salt VARCHAR(64) NOT NULL,
      hash CHAR(128) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id INT UNSIGNED NOT NULL,
      expires_at BIGINT NOT NULL,
      INDEX ix_session_user (user_id),
      CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await db.query('INSERT IGNORE INTO state (id, json, version) VALUES (1, NULL, 0)');
}

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
async function addUser(username, name, role, pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const [result] = await db.execute('INSERT INTO users(username,name,role,salt,hash) VALUES(?,?,?,?,?)',
    [username, name, role, salt, hashPw(pw, salt)]);
  return result;
}
async function createInitialAdmin(username, name, pw) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SELECT id FROM state WHERE id=1 FOR UPDATE');
    const [[{ c: existingUsers }]] = await connection.query('SELECT COUNT(*) c FROM users');
    if (existingUsers > 0) {
      await connection.rollback();
      return null;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const [result] = await connection.execute('INSERT INTO users(username,name,role,salt,hash) VALUES(?,?,?,?,?)',
      [username, name, 'admin', salt, hashPw(pw, salt)]);
    await connection.commit();
    return result.insertId;
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}
const cookieOf = (req, key) => (req.headers.cookie || '').split(';').map(s => s.trim().split('='))
  .find(([k]) => k === key)?.[1];
// Retrouve l'utilisateur connecté grâce au cookie de session
async function currentUser(req) {
  const tok = cookieOf(req, 'sid');
  if (!tok) return null;
  const [rows] = await db.execute(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                                  WHERE s.token_hash=? AND s.expires_at>?`, [sha(tok), Date.now()]);
  const row = rows[0];
  return row || null;
}
async function startSession(req, res, userId, body) {
  const tok = crypto.randomBytes(32).toString('hex');
  await db.execute('DELETE FROM sessions WHERE expires_at<?', [Date.now()]);   // ménage
  await db.execute('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)',
    [sha(tok), userId, Date.now() + SESSION_DAYS * 864e5]);
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  send(res, 200, body, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}` });
}
// Anti-force-brute : 5 erreurs de mot de passe => blocage 60 s
const fails = new Map();
const locked = k => (fails.get(k)?.until || 0) > Date.now();
const failed = k => { const f = fails.get(k) || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails.set(k, f); };

/* ---- 5. SIMULATION : tâches + 3 durées + état (tâche faite ou non) ---- */
async function buildSimulationInput(remainingOnly) {
  const connection = await db.getConnection();
  let row, estimates, lastEstimateUpdatedAt;
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    [[row]] = await connection.query('SELECT json, version FROM state WHERE id=1');
    [estimates] = await connection.query('SELECT task_id, optimistic, probable, pessimistic FROM estimates');
    [[{ lastEstimateUpdatedAt }]] = await connection.query('SELECT DATE_FORMAT(MAX(updated_at), \'%Y-%m-%d %H:%i:%s\') AS lastEstimateUpdatedAt FROM estimates');
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
  const S = row ? JSON.parse(row.json) : null;
  if (!S || !S.phases) return null;
  const est = new Map(estimates.map(r => [r.task_id, r]));
  const tasks = [], missing = [];
  S.phases.forEach((ph, i) => (ph.tasks || []).forEach(t => {
    if (remainingOnly && t.d) return;                    // tâche déjà terminée : plus d'incertitude
    const e = est.get(t.id);
    if (!e) return missing.push({ id: t.id, label: t.t, phase: ph.name });
    tasks.push({ id: t.id, label: t.t, phase: ph.name, phaseIndex: i, o: e.optimistic, m: e.probable, p: e.pessimistic });
  }));
  return { tasks, missing, source: { database: 'MySQL', stateVersion: row.version,
    usedEstimateCount: tasks.length, lastEstimateUpdatedAt } };
}

/* ---- 6. LE SERVEUR ---- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, method = req.method;

    if (p === '/api/health') return send(res, 200, { ok: true });

    /* --- Accès public : état de la session, première configuration, connexion --- */
    if (p === '/api/session' && method === 'GET') {
      const [[{ c: n }]] = await db.query('SELECT COUNT(*) c FROM users');
      const u = await currentUser(req);
      return send(res, 200, { user: u ? publicUser(u) : null, needsSetup: n === 0, roles: ROLES });
    }
    if (p === '/api/setup' && method === 'POST') {            // crée le 1er compte (admin), une seule fois
      const b = await readJsonBody(req);
      const username = String(b.username || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
      if (!username || !name || pw.length < 6) return send(res, 400, { error: 'Nom, identifiant et mot de passe (6 caractères min.) requis' });
      const userId = await createInitialAdmin(username, name, pw);
      if (userId === null) return send(res, 403, { error: 'déjà configuré' });
      return startSession(req, res, userId, { ok: true });
    }
    if (p === '/api/login' && method === 'POST') {
      const b = await readJsonBody(req);
      const key = String(b.username || '').toLowerCase() + '|' + req.socket.remoteAddress;
      if (locked(key)) return send(res, 429, { error: 'Trop d\'essais, réessayez dans 1 minute' });
      const [users] = await db.execute('SELECT * FROM users WHERE username=?', [String(b.username || '').trim()]);
      const u = users[0];
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
    const me = await currentUser(req);
    if (!me) return send(res, 401, { error: 'Connexion requise' });
    const canWrite = me.role !== 'lecteur';
    const isAdmin = me.role === 'admin';
    if (method !== 'GET' && p !== '/api/logout' && p !== '/api/me/password' && !canWrite)
      return send(res, 403, { error: 'Votre compte est en lecture seule' });

    if (p === '/api/logout' && method === 'POST') {
      await db.execute('DELETE FROM sessions WHERE token_hash=?', [sha(cookieOf(req, 'sid'))]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; Path=/; Max-Age=0' });
    }
    if (p === '/api/me/password' && method === 'PUT') {
      const b = await readJsonBody(req);
      if (!checkPw(me, String(b.old || ''))) return send(res, 400, { error: 'Ancien mot de passe incorrect' });
      if (String(b.password || '').length < 6) return send(res, 400, { error: 'Mot de passe : 6 caractères minimum' });
      const salt = crypto.randomBytes(16).toString('hex');
      await db.execute('UPDATE users SET salt=?, hash=? WHERE id=?', [salt, hashPw(String(b.password), salt), me.id]);
      return send(res, 200, { ok: true });
    }

    /* --- Gestion des comptes (administrateur seulement) --- */
    if (p.startsWith('/api/users')) {
      if (!isAdmin) return send(res, 403, { error: 'Réservé à l\'administrateur' });
      if (p === '/api/users' && method === 'GET') {
        const [users] = await db.query('SELECT id,username,name,role,created_at FROM users ORDER BY id');
        return send(res, 200, users);
      }
      if (p === '/api/users' && method === 'POST') {
        const b = await readJsonBody(req);
        const username = String(b.username || '').trim(), name = String(b.name || '').trim(), pw = String(b.password || '');
        if (!username || !name || pw.length < 6 || !ROLES.includes(b.role))
          return send(res, 400, { error: 'Nom, identifiant, rôle et mot de passe (6 caractères min.) requis' });
        try { await addUser(username, name, b.role, pw); }
        catch (e) {
          if (e.code === 'ER_DUP_ENTRY') return send(res, 409, { error: 'Cet identifiant existe déjà' });
          throw e;
        }
        return send(res, 201, { ok: true });
      }
      const id = Number(p.split('/')[3]);
      const [targets] = await db.execute('SELECT * FROM users WHERE id=?', [id]);
      const target = targets[0];
      if (!target) return send(res, 404, { error: 'introuvable' });
      if (method === 'DELETE') {
        if (target.id === me.id) return send(res, 400, { error: 'Vous ne pouvez pas supprimer votre propre compte' });
        await db.execute('DELETE FROM users WHERE id=?', [id]);
        return send(res, 200, { ok: true });
      }
      if (method === 'PUT') {                                   // réinitialiser le mot de passe / changer le rôle
        const b = await readJsonBody(req);
        if (b.password) {
          if (String(b.password).length < 6) return send(res, 400, { error: 'Mot de passe : 6 caractères minimum' });
          const salt = crypto.randomBytes(16).toString('hex');
          await db.execute('UPDATE users SET salt=?, hash=? WHERE id=?', [salt, hashPw(String(b.password), salt), id]);
          await db.execute('DELETE FROM sessions WHERE user_id=?', [id]);   // déconnecte l'intéressé
        }
        if (b.role) {
          if (!ROLES.includes(b.role)) return send(res, 400, { error: 'rôle inconnu' });
          if (target.id === me.id && b.role !== 'admin') return send(res, 400, { error: 'Vous ne pouvez pas retirer votre propre rôle admin' });
          await db.execute('UPDATE users SET role=? WHERE id=?', [b.role, id]);
        }
        return send(res, 200, { ok: true });
      }
    }

    /* --- Données du projet, AVEC PROTECTION ANTI-ÉCRASEMENT ---
       Chaque enregistrement porte un n° de version. Le client envoie la version qu'il a vue (baseVersion).
       Si quelqu'un d'autre a enregistré entre-temps => 409 + les données actuelles, et le client FUSIONNE
       au lieu d'écraser. La mise à jour conditionnelle en base rend le test atomique. */
    if (p === '/api/state') {
      if (method === 'GET') {
        const [[row]] = await db.query('SELECT json, version, updated_by FROM state WHERE id=1');
        const version = row ? row.version : 0;
        if (url.searchParams.get('since') === String(version)) return send(res, 200, { version, unchanged: true });
        return send(res, 200, { json: row ? row.json : null, version, updatedBy: row?.updated_by || null });
      }
      if (method === 'PUT') {
        const b = await readJsonBody(req);
        JSON.parse(b.json);                                              // doit être du JSON valide, sinon 400
        const baseVersion = Number(b.baseVersion);
        const [result] = await db.execute(`UPDATE state
          SET json=?, updated_at=CURRENT_TIMESTAMP, version=version+1, updated_by=?
          WHERE id=1 AND version=?`, [b.json, me.name, baseVersion]);
        if (result.affectedRows === 0) {
          const [[row]] = await db.query('SELECT json, version FROM state WHERE id=1');
          return send(res, 409, { error: 'conflit', json: row.json, version: row.version });
        }
        const next = baseVersion + 1;
        return send(res, 200, { ok: true, version: next });
      }
    }

    /* --- Photos --- */
    if (p === '/api/attachments' && method === 'GET') {
      const [rows] = await db.execute('SELECT id,file,description,created_at FROM attachments WHERE owner_type=? AND owner_id=? ORDER BY created_at',
        [url.searchParams.get('ownerType') || '', url.searchParams.get('ownerId') || '']);
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
      await db.execute('INSERT INTO attachments(id,owner_type,owner_id,file,mime,size,data,description) VALUES(?,?,?,?,?,?,?,?)',
        [id, String(b.ownerType), String(b.ownerId), file, kind[1], buf.length, buf, String(b.description || '').slice(0, 500)]);
      return send(res, 201, { id, file });
    }
    if (p.startsWith('/api/attachments/') && method === 'DELETE') {
      const id = p.split('/').pop();
      const [result] = await db.execute('DELETE FROM attachments WHERE id=?', [id]);
      if (!result.affectedRows) return send(res, 404, { error: 'introuvable' });
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/uploads/') && method === 'GET') {              // photos réservées aux comptes connectés
      const [rows] = await db.execute('SELECT mime,data FROM attachments WHERE file=?', [path.basename(p)]);
      if (!rows.length) return send(res, 404, { error: 'introuvable' });
      res.writeHead(200, {
        'Content-Type': rows[0].mime,
        'Cache-Control': 'private, max-age=31536000, immutable'
      });
      return res.end(rows[0].data);
    }

    /* --- Estimations PERT : liste de toutes les tâches --- */
    if (p === '/api/estimates' && method === 'GET') {
      const out = {};
      const [rows] = await db.query('SELECT * FROM estimates');
      for (const r of rows)
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
      await db.execute(`
        INSERT INTO estimates (task_id, optimistic, probable, pessimistic, updated_at, updated_by)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
        ON DUPLICATE KEY UPDATE
          optimistic = VALUES(optimistic),
          probable = VALUES(probable),
          pessimistic = VALUES(pessimistic),
          updated_at = VALUES(updated_at),
          updated_by = VALUES(updated_by)
      `, [taskId, optimistic, probable, pessimistic, me.name]);
      return send(res, 200, { ok: true });
    }

    /* --- b) Lancer la simulation --- GET /api/simulation?target=15&remaining=1 */
    if (method === 'GET' && p === '/api/simulation') {
      const remainingOnly = url.searchParams.get('remaining') !== '0';   // par défaut : seulement les tâches restantes
      const tq = parseFloat(url.searchParams.get('target'));
      const input = await buildSimulationInput(remainingOnly);
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
      result.source = input.source;
      return send(res, 200, result);
    }

    send(res, 404, { error: 'introuvable' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e instanceof SyntaxError ? 400 : 500,
      { error: e instanceof SyntaxError ? 'requête invalide' : 'erreur interne du serveur' });
  }
});

initializeDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`BTP-Vision tourne sur http://localhost:${PORT}`);
    scheduleDailyBackup();
  });
}).catch(e => {
  console.error('Connexion ou initialisation MySQL impossible :', e.message);
  db.end().catch(() => {});
  process.exitCode = 1;
});

function scheduleDailyBackup() {
  const nextRun = new Date();
  nextRun.setHours(2, 0, 0, 0);
  if (nextRun <= new Date()) nextRun.setDate(nextRun.getDate() + 1);
  const timer = setTimeout(() => {
    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', 'backup-db.js')], {
      cwd: __dirname,
      stdio: 'inherit',
      windowsHide: true
    });
    child.on('error', error => console.error('Sauvegarde quotidienne impossible :', error.message));
    child.on('close', code => {
      if (code !== 0) console.error(`La sauvegarde quotidienne a échoué (code ${code}).`);
      scheduleDailyBackup();
    });
  }, Math.max(1000, nextRun.getTime() - Date.now()));
  timer.unref();
}
