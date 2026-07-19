const os = require('os');
const WorkdirLock = require('./workdir-lock');
const { normalizeWorkdirPath } = WorkdirLock;

const DEFAULT_MEMORY_RETRY_MS = 15000;

function taskWorkdirPaths(task) {
  const entries = Array.isArray(task?.workdirs) && task.workdirs.length
    ? task.workdirs.map((entry) => entry?.path)
    : [task?.workdir];
  const paths = [];
  for (const entry of entries) {
    const normalized = normalizeWorkdirPath(entry);
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function isPlanTask(task) {
  return Boolean(task?.is_complex);
}

/**
 * Runs one task per project while allowing bounded cross-project concurrency.
 * Directory-level exclusion is delegated to a shared {@link WorkdirLock} so the
 * same guarantee also covers other writers (project deploy) in this process.
 *
 * Plan-mode tasks intentionally do NOT reserve their directories while planning
 * (planning is read-only); they acquire the directory lock only when execution
 * begins (see {@link WorkdirLock#acquire} wired through the runner).
 * @author Amadeus
 */
class ProjectScheduler {
  constructor({
    repo,
    maxConcurrent = 3,
    runTask,
    workdirLock,
    minFreeMemMB = 0,
    memoryRetryMs = DEFAULT_MEMORY_RETRY_MS,
    freeMem,
    onMemoryDefer,
  }) {
    this.repo = repo;
    this.maxConcurrent = maxConcurrent;
    this.runTask = runTask;
    this.activeProjects = new Set();
    this.runningTasks = new Map();
    this.workdirLock = workdirLock || new WorkdirLock();
    this.workdirLock.onRelease(() => this.kick());
    this.minFreeMemBytes = Math.max(0, Number(minFreeMemMB) || 0) * 1024 * 1024;
    this.memoryRetryMs = Number(memoryRetryMs) > 0 ? Number(memoryRetryMs) : DEFAULT_MEMORY_RETRY_MS;
    this.freeMem = typeof freeMem === 'function' ? freeMem : () => os.freemem();
    this.onMemoryDefer = typeof onMemoryDefer === 'function' ? onMemoryDefer : () => {};
    this.memoryTimer = null;
  }

  hasMemoryHeadroom() {
    if (this.minFreeMemBytes <= 0) return true;
    return this.freeMem() >= this.minFreeMemBytes;
  }

  scheduleMemoryRetry() {
    if (this.memoryTimer) return;
    this.memoryTimer = setTimeout(() => {
      this.memoryTimer = null;
      this.kick();
    }, this.memoryRetryMs);
    if (this.memoryTimer.unref) this.memoryTimer.unref();
  }

  get runningCount() {
    return this.runningTasks.size;
  }

  getRunningTaskIds() {
    return Array.from(this.runningTasks.keys());
  }

  canStart(task) {
    if (!task.project_id) return false;
    if (this.activeProjects.has(task.project_id)) return false;
    if (isPlanTask(task)) return true;
    return !this.workdirLock.isBusy(taskWorkdirPaths(task), task.id);
  }

  kick() {
    while (this.runningCount < this.maxConcurrent) {
      // 永远允许第 1 个任务运行以保证队列不卡死；只对“额外并发”任务做内存准入，
      // 空闲内存不足时暂缓，待有任务结束或延时后重新尝试，从机制上避免 pile-on OOM。
      if (this.runningCount > 0 && !this.hasMemoryHeadroom()) {
        this.onMemoryDefer({ freeMem: this.freeMem(), minFreeMemBytes: this.minFreeMemBytes });
        this.scheduleMemoryRetry();
        return;
      }
      const next = this.repo
        .listTasks('pending')
        .find((task) => this.canStart(task));
      if (!next) return;
      this.activeProjects.add(next.project_id);
      this.runningTasks.set(next.id, next.project_id);
      if (!isPlanTask(next)) {
        this.workdirLock.tryAcquire(next.id, taskWorkdirPaths(next));
      }
      Promise.resolve()
        .then(() => this.runTask(next))
        .catch(() => {
          // runTask owns persistence and error reporting
        })
        .finally(() => {
          this.runningTasks.delete(next.id);
          this.activeProjects.delete(next.project_id);
          this.workdirLock.release(next.id);
        });
    }
  }
}

module.exports = ProjectScheduler;
module.exports.taskWorkdirPaths = taskWorkdirPaths;
module.exports.isPlanTask = isPlanTask;
