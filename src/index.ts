import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Database } from './db/database.js';

const config = loadConfig();
const db = await Database.open(config.liveDbPath);
const app = await buildApp(config, db);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
