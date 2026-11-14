import { existsSync } from 'node:fs';
import path from 'node:path';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config, REPO_ROOT } from '../../shared/config.ts';
import { apiRoutes } from './routes/api.ts';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });
await app.register(compress);
await app.register(apiRoutes);

// In production the same process serves the built frontend (npm run build).
const webDist = path.join(REPO_ROOT, 'web', 'dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`data source: ${config.useFixtures ? 'fixtures' : 'DuckDB over ' + config.processedDir}`);
