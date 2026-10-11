import { setupServer } from 'msw/node'

/**
 * MSW server shared by all web tests. Tests add per-case handlers with
 * `server.use(http.get('/api/devices', () => HttpResponse.json([...])))`.
 */
export const server = setupServer()
