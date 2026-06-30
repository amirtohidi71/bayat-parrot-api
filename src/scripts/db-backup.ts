import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

dotenv.config();

const host = process.env.DB_HOST || 'localhost';
const port = process.env.DB_PORT || '5432';
const username = process.env.DB_USERNAME || 'postgres';
const password = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_NAME || 'postgres';

const backupDir = path.join(process.cwd(), 'backups');
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const filename = `${dbName}_${timestamp}.sql`;
const outputPath = path.join(backupDir, filename);

const env = { ...process.env, PGPASSWORD: password };

const pgDump =
  process.platform === 'win32'
    ? '"C:\\Program Files\\PostgreSQL\\17\\bin\\pg_dump.exe"'
    : 'pg_dump';

console.log(`Backing up database "${dbName}" to ${outputPath} ...`);

try {
  execSync(
    `${pgDump} -h ${host} -p ${port} -U ${username} -F p -f "${outputPath}" ${dbName}`,
    { env, stdio: 'inherit' },
  );
  console.log(`Backup complete: ${outputPath}`);
} catch {
  console.error('Backup failed. Make sure pg_dump is installed and accessible.');
  process.exit(1);
}
