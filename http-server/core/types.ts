import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteDef {
  method: 'GET' | 'POST';
  path: string | RegExp;
  handler: (ctx: RouteContext) => void | Promise<void>;
}

export interface RouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  payload: unknown;
  match?: RegExpExecArray;
}

export interface HttpModule {
  name: string;
  init?(): void | Promise<void>;
  dispose?(): void;
  routes(): RouteDef[];
}
