require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const mysql = require('mysql2/promise');

const users = [
  { username: 'marie.nkoa', name: 'Marie Nkoa', role: 'maitre_ouvrage' },
  { username: 'alain.tchoumi', name: 'Alain Tchoumi', role: 'maitre_oeuvre' },
  { username: 'diane.mbarga', name: 'Diane Mbarga', role: 'bet' },
  { username: 'paul.essomba', name: 'Paul Essomba', role: 'controle' },
  { username: 'serge.mpondo', name: 'Serge Mpondo', role: 'conducteur' },
  { username: 'joseph.biloa', name: 'Joseph Biloa', role: 'chef_chantier' },
  { username: 'ets.mbala', name: 'Établissements Mbala', role: 'entreprise' },
  { username: 'rita.ngono', name: 'Rita Ngono', role: 'fournisseur' },
  { username: 'lucie.etoa', name: 'Lucie Etoa', role: 'lecteur' }
];

const phaseNames = [
  'Préparation du site & terrassement', 'Fondations & infrastructure', 'Ossature (structure)',
  'Murs & maçonnerie', 'Toiture & charpente', 'Lots techniques (plomberie, électricité)',
  'Finitions & menuiserie', 'Contrôle & réception'
];
const taskNames = [
  ['Débroussaillage', 'Implantation & relevé', 'Terrassement au niveau'],
  ['Fouilles des semelles', 'Pose du ferraillage', 'Coulage du béton'],
  ['Poteaux', 'Poutres', 'Coulage de la dalle'],
  ['Blocs du rez-de-chaussée', 'Linteaux', "Blocs de l'étage"],
  ['Assemblage de la charpente', 'Tôles de toiture', 'Gouttières'],
  ['Plomberie (gros œuvre)', 'Gaines électriques', 'Essais'],
  ['Enduit', 'Carrelage', 'Portes & fenêtres', 'Peinture'],
  ['Liste des réserves', 'Inspection finale', 'Réception & remise des clés']
];
const activity = [
  'Réunion de lancement et validation des accès au site', 'Piquetage des limites de la parcelle',
  'Débroussaillage terminé sur l’emprise du bâtiment', 'Contrôle topographique des niveaux existants',
  'Implantation des axes et repères de référence', 'Terrassement de la plateforme commencé',
  'Évacuation des déblais vers la zone autorisée', 'Plateforme réglée et compactée',
  'Réception de la plateforme par le conducteur de travaux', 'Validation du plan d’installation de chantier',
  'Traçage des semelles et contrôle des diagonales', 'Fouilles des fondations ouvertes',
  'Contrôle du fond de fouille avant ferraillage', 'Armatures des semelles préparées',
  'Enrobage des aciers vérifié par le bureau de contrôle', 'Coulage du béton de propreté réalisé',
  'Ferraillage des semelles réceptionné', 'Béton des fondations coulé et éprouvettes prélevées',
  'Décoffrage des semelles après contrôle', 'Fondations réceptionnées, remblaiement autorisé',
  'Élévation des poteaux du rez-de-chaussée commencée', 'Contrôle de verticalité des poteaux',
  'Coffrage des poutres posé', 'Armatures des poutres vérifiées',
  'Réseaux traversants réservés avant dalle', 'Coulage de la dalle du rez-de-chaussée',
  'Cure du béton de dalle poursuivie', 'Résultats des éprouvettes conformes',
  'Décoffrage partiel autorisé', 'Structure du rez-de-chaussée réceptionnée',
  'Maçonnerie des murs du rez-de-chaussée démarrée', 'Contrôle de l’alignement des premières assises',
  'Linteaux préfabriqués livrés sur le chantier', 'Baies de portes et fenêtres vérifiées',
  'Élévation des murs de l’étage en cours', 'Réservations techniques repérées sur plans',
  'Maçonnerie de l’étage terminée', 'Contrôle des aplombs et dimensions des baies',
  'Réception des murs avant pose de la charpente', 'Approvisionnement du bois de charpente contrôlé',
  'Assemblage de la charpente commencé', 'Traitement préventif du bois appliqué',
  'Charpente levée et fixations contrôlées', 'Premières tôles de couverture posées',
  'Contrôle de l’étanchéité au droit du faîtage', 'Couverture principale achevée',
  'Gouttières en cours de pose', 'Essai d’écoulement des eaux pluviales effectué',
  'Réunion hebdomadaire : planning technique mis à jour', 'Point sécurité et rangement des zones de travail'
];

function config() {
  const raw = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (raw && ['mysql:', 'mysqls:'].includes(new URL(raw).protocol)) {
    const u = new URL(raw);
    return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)),
      ...(u.protocol === 'mysqls:' || process.env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) };
  }
  const { MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE } = process.env;
  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) throw new Error('Configuration MySQL absente dans .env.');
  return { host: MYSQL_HOST, port: Number(MYSQL_PORT || 3306), user: MYSQL_USER,
    password: MYSQL_PASSWORD || '', database: MYSQL_DATABASE,
    ...(process.env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}) };
}

function date(day) { return `2026-${String(day[0]).padStart(2, '0')}-${String(day[1]).padStart(2, '0')}`; }
function addDays(iso, days) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function randomPassword() { return `${crypto.randomBytes(15).toString('base64url')}!7`; }
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }

function pngScene(variant) {
  const width = 480, height = 270;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  const colors = { sky: [155, 207, 231, 255], cloud: [244, 248, 246, 255], soil: [184, 139, 86, 255],
    wall: [225, 207, 164, 255], shadow: [105, 116, 119, 255], window: [76, 120, 148, 255],
    roof: [130, 77, 53, 255], yellow: [232, 170, 43, 255], green: [70, 120, 76, 255] };
  const set = (x, y, c) => { const o = y * (width * 4 + 1) + 1 + x * 4; pixels[o] = c[0]; pixels[o + 1] = c[1]; pixels[o + 2] = c[2]; pixels[o + 3] = c[3]; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    pixels[y * (width * 4 + 1)] = 0;
    set(x, y, y < 184 ? colors.sky : colors.soil);
  }
  const rect = (x, y, w, h, c) => { for (let yy = y; yy < Math.min(height, y + h); yy++) for (let xx = x; xx < Math.min(width, x + w); xx++) set(xx, yy, c); };
  rect(52, 44, 74, 15, colors.cloud); rect(77, 34, 54, 20, colors.cloud); rect(332, 64, 80, 13, colors.cloud);
  const heightNow = 54 + variant * 12;
  rect(188, 184 - heightNow, 180, heightNow, colors.wall);
  rect(177, 178 - heightNow, 202, 9, colors.roof);
  for (let x = 207; x < 355; x += 40) rect(x, 196 - heightNow, 21, 28, colors.window);
  if (variant > 1) { for (let x = 207; x < 355; x += 40) rect(x, 147 - heightNow, 21, 28, colors.window); }
  rect(32, 168, 7, 56, colors.shadow); rect(24, 168, 48, 7, colors.yellow); rect(58, 168, 7, 22, colors.yellow);
  rect(24, 190, 36, 19, colors.yellow); rect(16, 208, 54, 9, colors.shadow); rect(25, 216, 11, 14, colors.shadow); rect(52, 216, 11, 14, colors.shadow);
  rect(405, 154, 11, 30, colors.green); rect(393, 172, 34, 10, colors.green);
  const crcTable = pngScene.crcTable || (pngScene.crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
  }));
  const crc32 = b => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  const db = await mysql.createConnection(config());
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const credentialsFile = path.join(__dirname, '..', 'backups', `comptes_demo_${stamp}.txt`);
  const credentials = users.map(user => ({ ...user, password: randomPassword() }));
  const phases = taskNames.map((labels, pi) => {
    const start = ['2026-06-01', '2026-06-16', '2026-07-10', '2026-08-20', '2026-10-18', '2026-11-03', '2026-12-05', '2027-02-10'][pi];
    const end = ['2026-06-15', '2026-07-05', '2026-08-10', '2026-10-10', '2026-11-20', '2026-12-04', '2027-02-09', '2027-03-20'][pi];
    const done = pi < 4 ? labels.length : pi === 4 ? 2 : 0;
    return { name: phaseNames[pi], status: pi < 4 ? 'Completed' : pi === 4 ? 'In Progress' : 'Not Started',
      ts: start, as: pi < 5 ? start : '', te: end, ae: pi < 4 ? end : '',
      tasks: labels.map((label, ti) => ({ id: `villa26-p${pi + 1}-t${ti + 1}`, t: label, d: ti < done })),
      photos: [], notes: [] };
  });
  const names = ['Administrateur', ...users.map(u => u.name)];
  const events = activity.map((t, i) => {
    const ranges = [[6, 1], [6, 16], [7, 10], [8, 20], [10, 1]];
    const group = Math.floor(i / 10), [month, day] = ranges[group];
    const offsets = [
      [0, 1, 3, 4, 6, 7, 9, 10, 12, 14], [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
      [0, 3, 6, 9, 12, 15, 18, 21, 24, 27], [0, 4, 8, 12, 16, 20, 24, 28, 32, 36],
      [0, 3, 6, 9, 12, 15, 18, 21, 24, 27]
    ][group];
    return { d: addDays(date([month, day]), offsets[i % 10]), t, by: names[(i * 3 + Math.floor(i / 4)) % names.length] };
  });
  events[0] = { d: '2026-06-01', t: 'Projet créé et réunion de lancement tenue', by: 'Administrateur' };
  events[19] = { d: '2026-07-05', t: 'Fondations terminées et réceptionnées', by: 'Marie Nkoa' };
  events[39] = { d: '2026-10-10', t: 'Maçonnerie terminée avant démarrage de la toiture', by: 'Alain Tchoumi' };

  const reportItems = [
    [6, 3, 'Ensoleillé', 9, 'Débroussaillage et décapage de la terre végétale. Zone de stockage balisée.', 0],
    [6, 10, 'Nuageux', 8, 'Implantation des axes contrôlée avec le géomètre. Évacuation des déblais.', 0],
    [6, 22, 'Pluie légère', 11, 'Fouilles des semelles poursuivies après drainage des points bas.', 1],
    [6, 29, 'Ensoleillé', 12, 'Ferraillage des semelles achevé. Contrôle des aciers et enrobages.', 1],
    [7, 3, 'Ensoleillé', 14, 'Coulage du béton des fondations. Éprouvettes prélevées et zone protégée.', 1],
    [7, 18, 'Nuageux', 10, 'Montage des poteaux et vérification des aplombs.', 2],
    [7, 29, 'Ensoleillé', 16, 'Coffrage et ferraillage des poutres. Réservations techniques confirmées.', 2],
    [8, 6, 'Chaud et sec', 18, 'Dalle du rez-de-chaussée coulée. Cure du béton et accès limités.', 2],
    [8, 28, 'Nuageux', 13, 'Élévation des murs du rez-de-chaussée. Linteaux mis en place.', 3],
    [9, 15, 'Pluie', 12, 'Maçonnerie de l’étage poursuivie à l’abri. Livraison de blocs contrôlée.', 3],
    [10, 10, 'Ensoleillé', 15, 'Réception des murs et contrôle des baies avant pose de la charpente.', 3],
    [10, 27, 'Nuageux', 17, 'Charpente assemblée, couverture principale posée, gouttières en cours.', 4]
  ];
  const reports = reportItems.map(([m, d, weather, workers, summary, phase], i) => ({
    id: `rapport-villa26-${String(i + 1).padStart(2, '0')}`, date: date([m, d]), phase, weather, workers, summary,
    by: names[(i * 2 + 5) % names.length]
  }));
  const noteItems = [
    [0, 6, 4, 'Conserver les repères topographiques jusqu’à la réception des fondations.'],
    [1, 6, 18, 'Prévoir une pompe de secours en cas de remontée d’eau dans les fouilles.'],
    [1, 7, 1, 'Les bons de livraison du béton sont classés dans le dossier chantier.'],
    [2, 7, 19, 'Respecter le délai de cure avant le décoffrage des éléments porteurs.'],
    [2, 8, 2, 'Maintenir les réservations de plomberie et électricité conformes aux plans.'],
    [3, 8, 24, 'Échantillon de blocs validé par la maîtrise d’œuvre.'],
    [3, 9, 12, 'Protéger les baies et les angles pendant la manutention des matériaux.'],
    [3, 10, 5, 'Murs réceptionnés sous réserve de la reprise locale près de la cage d’escalier.'],
    [4, 10, 19, 'Stocker les tôles à plat et à l’abri avant la pose.'],
    [4, 10, 27, 'Vérifier les fixations de rive avant l’essai d’étanchéité.'],
    [5, 11, 2, 'Les plans d’exécution des réseaux seront transmis avant le démarrage des lots techniques.'],
    [6, 10, 28, 4, 'Choisir les teintes de finition après validation des échantillons sur site.'],
    [7, 10, 20, 10, 'Préparer la liste de contrôle et les documents de réception en amont.'],
    [7, 10, 30, 1, 'Archiver les procès-verbaux de contrôle avec les rapports journaliers.']
  ];
  noteItems.forEach(([pi, m, d, t], i) => phases[pi].notes.push({ d: date([m, d]), t, by: names[(i * 4 + 2) % names.length] }));

  const project = { proj: { name: 'Villa R+1 Bonamoussadi', loc: 'Bonamoussadi, Douala, Cameroun', start: '2026-06-01',
    end: '2027-03-31', budget: 45000000 }, phases, ev: events, reports };
  const attachmentRows = [];
  const imageDescriptions = ['Vue générale du chantier après terrassement', 'Fondations et ferraillage contrôlés',
    'Poteaux et poutres du rez-de-chaussée', 'Dalle béton après coulage', 'Maçonnerie du rez-de-chaussée',
    'Murs de l’étage en cours', 'Charpente assemblée', 'Couverture et évacuation des eaux pluviales'];
  for (let i = 0; i < 8; i++) {
    const id = crypto.randomUUID();
    const ownerType = i < 4 ? 'phase' : 'report';
    const ownerId = i < 4 ? `p${i}` : reports[i - 4].id;
    attachmentRows.push([id, ownerType, ownerId, `${id}.png`, 'image/png', pngScene(i), imageDescriptions[i],
      `${date([[6, 15], [7, 5], [8, 10], [10, 10], [6, 3], [6, 10], [6, 22], [6, 29]][i])} 15:30:00`]);
  }

  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  try {
    await db.beginTransaction();
    const [[state]] = await db.query('SELECT json, version FROM state WHERE id=1 FOR UPDATE');
    if (!state || state.json) throw new Error('Un projet existe déjà dans la base. Aucune donnée n’a été remplacée.');
    const [existing] = await db.execute('SELECT username FROM users WHERE username IN (?)', [users.map(u => u.username)]);
    if (existing.length) throw new Error(`Certains identifiants existent déjà (${existing.map(u => u.username).join(', ')}).`);

    for (const user of credentials) {
      const salt = crypto.randomBytes(16).toString('hex');
      const createdAt = `${addDays('2026-05-25', users.indexOf(user))} 09:00:00`;
      const [result] = await db.execute('INSERT INTO users(username,name,role,salt,hash,created_at) VALUES(?,?,?,?,?,?)',
        [user.username, user.name, user.role, salt, passwordHash(user.password, salt), createdAt]);
    }

    const adminName = 'Administrateur';
    const [[admin]] = await db.query("SELECT id,name FROM users WHERE role='admin' ORDER BY id LIMIT 1");
    if (!admin) throw new Error('Aucun compte administrateur trouvé.');
    for (let i = 0; i < names.length; i++) if (names[i] === adminName) names[i] = admin.name;
    for (const event of events) if (event.by === adminName) event.by = admin.name;
    for (const report of reports) if (report.by === adminName) report.by = admin.name;
    for (const phase of phases) for (const note of phase.notes) if (note.by === adminName) note.by = admin.name;
    project.reports = reports;

    for (let pi = 0, taskIndex = 0; pi < phases.length; pi++) for (let ti = 0; ti < phases[pi].tasks.length; ti++, taskIndex++) {
      const task = phases[pi].tasks[ti];
      const probable = [3, 5, 4, 6, 2, 7][taskIndex % 6] + (pi > 3 ? 2 : 0);
      const optimistic = Math.max(1, Math.round(probable * 0.6 * 2) / 2);
      const pessimistic = Math.round(probable * 1.8 * 2) / 2;
      const updateDate = task.d
        ? (pi === 4 ? addDays(phases[pi].as, ti === 0 ? 4 : 9) : phases[pi].ae)
        : phases[pi].as || phases[pi].ts;
      const contributor = names[(taskIndex * 2 + 3) % names.length];
      await db.execute('INSERT INTO estimates(task_id,optimistic,probable,pessimistic,updated_at,updated_by) VALUES(?,?,?,?,?,?)',
        [task.id, optimistic, probable, pessimistic, `${updateDate} 12:00:00`, contributor]);
    }

    for (const [id, ownerType, ownerId, file, mime, data, description, createdAt] of attachmentRows) {
      await db.execute('INSERT INTO attachments(id,owner_type,owner_id,file,mime,size,data,description,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
        [id, ownerType, ownerId, file, mime, data.length, data, description, createdAt]);
    }

    const stateJson = JSON.stringify(project);
    await db.execute('UPDATE state SET json=?,updated_at=CURRENT_TIMESTAMP,version=version+1,updated_by=? WHERE id=1 AND version=?',
      [stateJson, admin.name, state.version]);
    fs.writeFileSync(credentialsFile, [
      'COMPTES DE DÉMONSTRATION BTP-VISION',
      'Les mots de passe ne sont affichés qu’une seule fois. Conservez ce fichier en lieu sûr.',
      'Le compte administrateur existant n’a pas été modifié.', '',
      ...credentials.map(u => `${u.name} | ${u.role} | ${u.username} | ${u.password}`), ''
    ].join('\n'), { encoding: 'utf8', flag: 'wx' });
    await db.commit();
    console.log(JSON.stringify({ usersAdded: credentials.length, project: project.proj.name, phases: phases.length,
      tasks: phases.reduce((n, p) => n + p.tasks.length, 0), journalInteractions: events.length,
      reports: reports.length, notes: noteItems.length, attachments: attachmentRows.length,
      credentialsFile: path.relative(process.cwd(), credentialsFile) }, null, 2));
  } catch (error) {
    await db.rollback().catch(() => {});
    if (fs.existsSync(credentialsFile)) fs.unlinkSync(credentialsFile);
    throw error;
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(`Remplissage impossible : ${error.code || error.message}`);
  process.exitCode = 1;
});
