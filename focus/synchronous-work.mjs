import { performance } from 'node:perf_hooks';

// Diagnostic-only accounting. A check-phase boundary is a conservative yield:
// synchronous pieces before it add together, including promise continuations,
// while time spent awaiting I/O is never added to the occupied milliseconds.
export function createSynchronousWorkMeter({ now = () => performance.now(), scheduleBoundary = setImmediate, cancelBoundary = clearImmediate, onBlock } = {}) {
  const scopes = new Set();
  let blockMs = 0, boundary, depth = 0;
  const endBlock = () => {
    boundary = undefined;
    const completed = blockMs;
    blockMs = 0;
    if (completed > 0) onBlock?.(completed);
  };
  const add = duration => {
    if (depth || !Number.isFinite(duration) || duration < 0) return;
    blockMs += duration;
    for (const scope of scopes) scope.maxMs = Math.max(scope.maxMs, blockMs);
    if (boundary === undefined) boundary = scheduleBoundary(endBlock);
  };
  return {
    add,
    measure(fn) {
      if (depth) return fn();
      const started = now();
      depth++;
      try { return fn(); }
      finally { depth--; add(now() - started); }
    },
    startScope() {
      const scope = { maxMs: blockMs, finish() { scopes.delete(scope); return scope.maxMs; } };
      scopes.add(scope);
      return scope;
    },
    close() { if (boundary !== undefined) cancelBoundary(boundary); endBlock(); scopes.clear(); },
  };
}
