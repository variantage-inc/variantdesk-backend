import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env, isDev } from './lib/env.js';
import { api } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  /* The browser sends cookies for the refresh token, so the origin has to be
     named explicitly. A wildcard is not allowed with credentials. */
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  if (isDev) app.use(morgan('dev'));

  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
