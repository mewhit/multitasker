import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HOST } from './constants';
import { getErrorMessage } from './util';
import { HttpBodyTooLargeError, readHttpBody, writeJsonResponse } from './body';
import { Router } from './router';
import type { RouteContext } from './types';

let server: Server | null = null;

export function getServer(): Server | null {
  return server;
}

export function startHttpServer(port: number, router: Router, onStarted?: () => void): void {
  if (server) return;

  server = createServer((request, response) => {
    void handleHttpRequest(request, response, router);
  });
  server.on('error', error => {
    console.error(`Failed to start Multitasker backend: ${getErrorMessage(error)}`);
    stopHttpServer();
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    console.info(`Multitasker backend listening on http://${HOST}:${port}`);
    onStarted?.();
  });
}

export function stopHttpServer(): void {
  if (server) {
    try {
      server.close();
    } catch {
      // The server may fail before it starts listening.
    }
    server = null;
  }
}

async function handleHttpRequest(request: IncomingMessage, response: ServerResponse, router: Router): Promise<void> {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const requestUrl = new URL(request.url ?? '/', `http://${HOST}`);
  const requestPath = requestUrl.pathname;
  const method = request.method ?? 'GET';

  const routeMatch = router.match(method, requestPath);
  if (!routeMatch) {
    writeJsonResponse(response, 404, { ok: false, error: 'not_found' });
    return;
  }

  let payload: unknown = {};
  if (method === 'POST') {
    try {
      const rawBody = await readHttpBody(request);
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch (error) {
      const statusCode = error instanceof HttpBodyTooLargeError ? 413 : 400;
      writeJsonResponse(response, statusCode, { ok: false, error: getErrorMessage(error) });
      return;
    }
  }

  const ctx: RouteContext = {
    request,
    response,
    url: requestUrl,
    payload,
  };
  if (routeMatch.match) ctx.match = routeMatch.match;

  await routeMatch.handler(ctx);
}
