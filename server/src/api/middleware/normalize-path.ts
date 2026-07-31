/**
 * Path Normalization Middleware
 * Collapses duplicate slashes in the request path before routing.
 */

import { Request, Response, NextFunction } from 'express';

/**
 * Collapse runs of slashes in the path portion of a URL, leaving the query
 * string untouched: `//api/media/1/download?x=a//b` → `/api/media/1/download?x=a//b`.
 */
export function collapseSlashes(url: string): string {
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q);
  return path.replace(/\/{2,}/g, '/') + query;
}

/**
 * Express middleware: rewrite req.url so routes mounted at e.g. /api/media
 * also match requests for //api/media. Fielded clients build download URLs
 * by string concat (`{server_url}/api/media/:id/download`); a trailing slash
 * in their configured server URL produces a double-slash path, which Express
 * mount matching does not recognize — every media download fell through to
 * the 404 handler. Normalizing here keeps those clients working no matter
 * how their server URL is written.
 */
export function normalizePath() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.url.includes('//')) {
      req.url = collapseSlashes(req.url);
    }
    next();
  };
}
