const path = require('path');

function normalizeWorkdirPath(value) {
  if (!value) return null;
  let resolved = path.resolve(String(value)).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') resolved = resolved.toLowerCase();
  return resolved;
}

function normalizePaths(rawPaths) {
  const list = Array.isArray(rawPaths) ? rawPaths : [rawPaths];
  const paths = [];
  for (const entry of list) {
    const normalized = normalizeWorkdirPath(entry);
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function pathsOverlap(a, b) {
  if (a === b) return true;
  const sep = path.sep === '\\' ? '\\' : '/';
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Process-wide mutual exclusion over physical working directories.
 *
 * Every writer (scheduled task execution, project deploy, ...) must hold the
 * lock for the directories it touches, so two writers never mutate the same
 * git worktree (or a parent/child directory of it) at the same time.
 *
 * The lock is non-reentrant across owners but tolerant to the same owner: an
 * owner that already holds a superset simply re-affirms its hold. Callers that
 * can afford to wait use {@link acquire} (async); pollers such as the task
 * scheduler use {@link isBusy} + {@link tryAcquire} (sync, non-blocking).
 *
 * Deadlock-freedom: each owner grabs its entire path set in a single call, so
 * there is never a "hold one, wait for another" cycle.
 * @author Amadeus
 */
class WorkdirLock {
  constructor() {
    this.held = new Map();
    this.waiters = [];
    this.listeners = [];
  }

  onRelease(fn) {
    if (typeof fn === 'function') this.listeners.push(fn);
  }

  _notify() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (_) {
        // listener failures must never break the lock
      }
    }
  }

  _conflict(paths, ownerId) {
    for (const [owner, heldPaths] of this.held) {
      if (owner === ownerId) continue;
      if (paths.some((candidate) => heldPaths.some((locked) => pathsOverlap(candidate, locked)))) {
        return true;
      }
    }
    return false;
  }

  isBusy(rawPaths, ownerId) {
    const paths = normalizePaths(rawPaths);
    if (!paths.length) return false;
    return this._conflict(paths, ownerId);
  }

  tryAcquire(ownerId, rawPaths) {
    const paths = normalizePaths(rawPaths);
    if (!paths.length) return true;
    if (this._conflict(paths, ownerId)) return false;
    this.held.set(ownerId, paths);
    return true;
  }

  acquire(ownerId, rawPaths) {
    const paths = normalizePaths(rawPaths);
    if (!paths.length) return Promise.resolve();
    if (!this._conflict(paths, ownerId)) {
      this.held.set(ownerId, paths);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ ownerId, paths, resolve, reject });
    });
  }

  release(ownerId) {
    this.held.delete(ownerId);
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.ownerId === ownerId) {
        waiter.reject(new Error('等待工作目录锁时被取消'));
        return false;
      }
      return true;
    });
    const remaining = [];
    for (const waiter of this.waiters) {
      if (!this.held.has(waiter.ownerId) && !this._conflict(waiter.paths, waiter.ownerId)) {
        this.held.set(waiter.ownerId, waiter.paths);
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    this.waiters = remaining;
    this._notify();
  }

  get heldCount() {
    return this.held.size;
  }

  get waiterCount() {
    return this.waiters.length;
  }
}

module.exports = WorkdirLock;
module.exports.normalizeWorkdirPath = normalizeWorkdirPath;
module.exports.normalizePaths = normalizePaths;
module.exports.pathsOverlap = pathsOverlap;
