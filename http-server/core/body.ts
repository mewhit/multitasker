import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAX_HTTP_BODY_BYTES } from './constants';

export class HttpBodyTooLargeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'HttpBodyTooLargeError';
  }
}

export function readHttpBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bodyBytes = 0;
    let rejected = false;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      if (rejected) return;
      bodyBytes += Buffer.byteLength(chunk, 'utf8');
      if (bodyBytes > MAX_HTTP_BODY_BYTES) {
        rejected = true;
        reject(new HttpBodyTooLargeError('request payload is too large'));
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!rejected) resolve(body);
    });
    request.on('error', error => {
      if (!rejected) reject(error);
    });
  });
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readHttpBody(request);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
  const encodedBody = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(encodedBody),
  });
  response.end(encodedBody);
}
