require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

function connectionConfig() {
  const rawUrl = process.env.MYSQL_URL || process.env.DATABASE_URL;
  if (rawUrl && ['mysql:', 'mysqls:'].includes(new URL(rawUrl).protocol)) {
    const url = new URL(rawUrl);
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
  if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_DATABASE) {
    throw new Error('Configurez MYSQL_URL ou MYSQL_HOST, MYSQL_USER et MYSQL_DATABASE dans .env.');
  }
  return {
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT || 3306),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD || '',
    database: MYSQL_DATABASE,
    ...(process.env.MYSQL_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {})
  };
}

const identifier = value => `\`${String(value).replace(/`/g, '``')}\``;
function literal(value) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value instanceof Date) value = value.toISOString().slice(0, 19).replace('T', ' ');
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\0/g, '\\0').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`;
}

function splitSql(sql) {
  const statements = [];
  let start = 0, quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === '\\' && quote !== '`') { i++; continue; }
      if (ch === quote) {
        if (sql[i + 1] === quote) { i++; continue; }
        quote = null;
      }
    } else if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === ';') {
      const statement = sql.slice(start, i).replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  return statements;
}

async function verifyRestore(db, sql, database, expectedCounts) {
  const testDatabase = `btp_backup_check_${process.pid}_${Date.now()}`;
  await db.query(`CREATE DATABASE ${identifier(testDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  try {
    await db.query(`USE ${identifier(testDatabase)}`);
    for (const statement of splitSql(sql)) {
      if (/^(CREATE DATABASE|USE\s)/i.test(statement)) continue;
      await db.query(statement);
    }
    for (const [table, expected] of Object.entries(expectedCounts)) {
      const [[row]] = await db.query(`SELECT COUNT(*) AS count FROM ${identifier(table)}`);
      if (Number(row.count) !== expected) throw new Error(`Vérification de restauration échouée pour ${table}.`);
    }
  } finally {
    await db.query(`DROP DATABASE IF EXISTS ${identifier(testDatabase)}`);
    await db.query(`USE ${identifier(database)}`);
  }
}

function pruneBackups(dir, database, keepDays = 30) {
  const cutoff = Date.now() - keepDays * 864e5;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(`${database}_`) || !entry.name.endsWith('.sql')) continue;
    const file = path.join(dir, entry.name);
    if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
  }
}

async function main() {
  const db = await mysql.createConnection({ ...connectionConfig(), supportBigNumbers: true, bigNumberStrings: true });
  try {
    const database = db.config.database;
    const [tables] = await db.query('SHOW FULL TABLES WHERE Table_type = \'BASE TABLE\'');
    const tableNames = tables.map(row => Object.values(row)[0]).sort();
    const expectedCounts = {};
    const lines = [
      `-- BTP-Vision MySQL backup: ${new Date().toISOString()}`,
      `-- Database: ${database}`,
      'SET NAMES utf8mb4;',
      'SET FOREIGN_KEY_CHECKS=0;',
      `CREATE DATABASE IF NOT EXISTS ${identifier(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `USE ${identifier(database)};`,
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;',
      'START TRANSACTION WITH CONSISTENT SNAPSHOT;'
    ];

    for (const table of tableNames) {
      const [[definition]] = await db.query(`SHOW CREATE TABLE ${identifier(table)}`);
      lines.push('', `DROP TABLE IF EXISTS ${identifier(table)};`, `${definition['Create Table']};`);
      const [rows] = await db.query(`SELECT * FROM ${identifier(table)}`);
      expectedCounts[table] = rows.length;
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      lines.push(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(', ')}) VALUES`);
      lines.push(rows.map(row => `(${columns.map(column => literal(row[column])).join(', ')})`).join(',\n') + ';');
    }

    lines.push('COMMIT;', 'SET FOREIGN_KEY_CHECKS=1;', '');
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const file = path.join(dir, `${database}_${stamp}.sql`);
    const sql = lines.join('\n');
    await verifyRestore(db, sql, database, expectedCounts);
    fs.writeFileSync(file, sql, { encoding: 'utf8', flag: 'wx' });
    pruneBackups(dir, database);
    console.log(`Sauvegarde vérifiée : ${path.relative(process.cwd(), file)} (${tableNames.length} tables, rétention 30 jours)`);
  } finally {
    await db.end();
  }
}

main().catch(error => {
  console.error(`Sauvegarde impossible : ${error.code || error.message}`);
  process.exitCode = 1;
});
