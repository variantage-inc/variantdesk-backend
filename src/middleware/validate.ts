import type { NextFunction, Request, Response } from 'express';
import type { ZodTypeAny } from 'zod';

/* Validation happens at the edge, once. Everything past this point can trust
   the shape of req.body, so services do not repeat the checks and cannot
   disagree about them. Failures are thrown for the error handler to format,
   which is what turns them into per field messages the form can display. */
export const validate =
  (schema: ZodTypeAny) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(result.error);
    req.body = result.data;
    next();
  };
