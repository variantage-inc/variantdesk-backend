import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { isDev } from './lib/env.js';
import { corsOrigins } from './lib/cookies.js';
import { api } from './routes/index.js';
import { errorHandler, notFound } from './middleware/error.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  /* Behind Railway or Render the client address arrives in X-Forwarded-For.
     Without this req.ip is the load balancer, and rate limiting would treat
     every user in the world as the same person. */
  app.set('trust proxy', 1);
  app.use(helmet());
  /* The browser sends cookies for the refresh token, so the origin has to be
     named explicitly. A wildcard is not allowed with credentials. */
  app.use(cors({ origin: corsOrigins(), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: true }));
  if (isDev) app.use(morgan('dev'));

  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
