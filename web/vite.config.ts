import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API runs on its own port in dev; in production Fastify serves web/dist itself.
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 3001}` },
  },
});
