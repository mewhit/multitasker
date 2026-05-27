import type { ServerResponse } from 'node:http';

export const sseClients = new Set<ServerResponse>();

export function broadcastSseEvent(event: string, payload: unknown): void {
  for (const client of [...sseClients]) {
    if (client.writableEnded) {
      sseClients.delete(client);
      continue;
    }
    writeSseEvent(client, event, payload);
  }
}

export function writeSseEvent(response: ServerResponse, event: string, payload: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function closeSseClients(): void {
  for (const client of [...sseClients]) {
    client.end();
  }
  sseClients.clear();
}
