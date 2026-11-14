import { existsSync } from 'node:fs';
import path from 'node:path';
import compress from '@fastify/compress';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { config, REPO_ROOT } from './config.ts';
import { warmUp } from './dataset.ts';
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
app.log.info(
  `DuckDB limits: memory ${config.duckdb.memoryLimit}, ${config.duckdb.threads} threads, query timeout ${config.limits.queryTimeoutMs / 1000} s`,
);
// Compute dataset metadata in the background so the first page load is fast.
void warmUp((msg) => app.log.info(msg));
