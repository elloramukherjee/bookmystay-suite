import { describe, expect, it } from 'vitest';
import { api, useTestDatabase } from '../test/helpers.js';

useTestDatabase();

describe('API root and health aliases', () => {
  it('GET / describes the API when the web app is not served from here', async () => {
    const res = await api().get('/');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'Welcome to BookMyStay API', status: 'Running', api: '/api/v1' });
  });

  it('GET /api/health and /api/v1/health report the database state', async () => {
    for (const path of ['/api/health', '/api/v1/health']) {
      const res = await api().get(path);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, message: 'BookMyStay API is healthy', data: { status: 'ok', db: 'connected' } });
    }
  });

  it('unknown routes are still a JSON 404', async () => {
    const res = await api().get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
