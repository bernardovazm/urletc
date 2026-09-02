// Minimal hash router (ARCHITECTURE section 2). No history-API rewrites, framework-free.
// Routes are plain strings like "/" or "/t/<tool-id>"; a single handler dispatches.

export type RouteHandler = (path: string) => void | Promise<void>

/**
 * Routes that no longer exist and must not dead-end. URL Inspector was merged into URL
 * Check, and links to the old id are already out in shared history. Rewriting the hash
 * (rather than silently handing the handler another path) keeps the address bar honest
 * and re-dispatches through `hashchange`, so the handler only ever sees a live route.
 */
const REDIRECTS: Record<string, string> = { '/t/url-info': '/t/url-check' }

export class Router {
  constructor(private readonly handler: RouteHandler) {}

  start(): void {
    window.addEventListener('hashchange', () => this.dispatch())
    this.dispatch()
  }

  private dispatch(): void {
    const path = location.hash.replace(/^#/, '') || '/'
    const moved = REDIRECTS[path]
    if (moved) {
      location.hash = moved
      return
    }
    void this.handler(path)
  }

  static go(path: string): void {
    location.hash = path
  }
}
