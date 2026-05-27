import type { RouteDef, RouteContext } from './types';

interface ExactRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: (ctx: RouteContext) => void | Promise<void>;
}

interface RegexRoute {
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: (ctx: RouteContext) => void | Promise<void>;
}

export class Router {
  private exactRoutes = new Map<string, ExactRoute>();
  private regexRoutes: RegexRoute[] = [];

  constructor(routes: RouteDef[]) {
    for (const route of routes) {
      if (typeof route.path === 'string') {
        const key = `${route.method}:${route.path}`;
        if (this.exactRoutes.has(key)) {
          throw new Error(`Duplicate route: ${route.method} ${route.path}`);
        }
        this.exactRoutes.set(key, {
          method: route.method,
          path: route.path,
          handler: route.handler,
        });
      } else {
        this.regexRoutes.push({
          method: route.method,
          pattern: route.path,
          handler: route.handler,
        });
      }
    }
  }

  match(method: string, path: string): { handler: (ctx: RouteContext) => void | Promise<void>; match?: RegExpExecArray } | null {
    // Exact match takes priority
    const exactKey = `${method}:${path}`;
    const exactRoute = this.exactRoutes.get(exactKey);
    if (exactRoute) {
      return { handler: exactRoute.handler };
    }

    // Try regex routes
    for (const regexRoute of this.regexRoutes) {
      if (regexRoute.method !== method) continue;
      const match = regexRoute.pattern.exec(path);
      if (match) {
        return { handler: regexRoute.handler, match };
      }
    }

    return null;
  }
}

export function buildRouter(routes: RouteDef[]): Router {
  return new Router(routes);
}
