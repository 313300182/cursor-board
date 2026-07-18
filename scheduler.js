const WorkdirLock = require('./workdir-lock');
const { normalizeWorkdirPath } = WorkdirLock;

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
  constructor({ repo, maxConcurrent = 3, runTask, workdirLock }) {
    this.repo = repo;
    this.maxConcurrent = maxConcurrent;
    this.runTask = runTask;
    this.activeProjects = new Set();
    this.runningTasks = new Map();
    this.workdirLock = workdirLock || new WorkdirLock();
    this.workdirLock.onRelease(() => this.kick());
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
