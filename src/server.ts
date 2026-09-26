/* First, so Sentry is ready before anything else can fail. */
import './lib/sentry.js';
import { createApp } from './app.js';
import { env } from './lib/env.js';
import { prisma } from './lib/prisma.js';
import { startHousekeeping } from './lib/housekeeping.js';

const app = createApp();
startHousekeeping();

const server = app.listen(env.PORT, () => {
  console.log(`Variantage API listening on http://localhost:${env.PORT}`);
  console.log(`Health check:              http://localhost:${env.PORT}/api/health`);
});

/* Close the pool on the way out so nodemon/tsx restarts and container stops do
   not leave connections hanging around on Postgres. */
const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down.`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
