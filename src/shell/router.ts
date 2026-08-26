// Minimal hash router (ARCHITECTURE section 2). No history-API rewrites, framework-free.
// Routes are plain strings like "/" or "/t/<tool-id>"; a single handler dispatches.

export type RouteHandler = (path: string) => void | Promise<void>

export class Router {
  constructor(private readonly handler: RouteHandler) {}

  start(): void {
    window.addEventListener('hashchange', () => this.dispatch())
    this.dispatch()
  }

  private dispatch(): void {
    const path = location.hash.replace(/^#/, '') || '/'
    void this.handler(path)
  }

  static go(path: string): void {
    location.hash = path
  }
}
