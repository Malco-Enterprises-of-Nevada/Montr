/**
 * Unit tests for the path normalization middleware.
 *
 * Regression coverage for fielded clients that build download URLs by string
 * concat with a trailing-slash server URL, producing //api/... paths that
 * Express route mounts don't match (every media download 404'd).
 */

import { Request, Response, NextFunction } from 'express';
import { collapseSlashes, normalizePath } from '../../../src/api/middleware/normalize-path';

describe('collapseSlashes', () => {
  it('collapses a double leading slash', () => {
    expect(collapseSlashes('//api/media/34/download')).toBe('/api/media/34/download');
  });

  it('collapses runs of slashes anywhere in the path', () => {
    expect(collapseSlashes('/api//media///34/download')).toBe('/api/media/34/download');
  });

  it('leaves a normal path untouched', () => {
    expect(collapseSlashes('/api/media/34/download')).toBe('/api/media/34/download');
  });

  it('does not touch slashes in the query string', () => {
    expect(collapseSlashes('//api/media?redirect=https://example.com//x')).toBe(
      '/api/media?redirect=https://example.com//x'
    );
  });

  it('handles the bare root path', () => {
    expect(collapseSlashes('/')).toBe('/');
    expect(collapseSlashes('//')).toBe('/');
  });
});

describe('normalizePath middleware', () => {
  function run(url: string): { req: Request; next: NextFunction } {
    const req = { url } as Request;
    const res = {} as Response;
    const next = jest.fn();
    normalizePath()(req, res, next);
    return { req, next };
  }

  it('rewrites req.url when the path has duplicate slashes', () => {
    const { req, next } = run('//api/media/34/download');
    expect(req.url).toBe('/api/media/34/download');
    expect(next).toHaveBeenCalledWith();
  });

  it('leaves clean urls alone and calls next()', () => {
    const { req, next } = run('/api/media/34/download?range=0-100');
    expect(req.url).toBe('/api/media/34/download?range=0-100');
    expect(next).toHaveBeenCalledWith();
  });
});
