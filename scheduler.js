/**
 * Runs one task per project while allowing bounded cross-project concurrency.
 * @author Amadeus
 */
class ProjectScheduler {
  constructor({ repo, maxConcurrent = 3, runTask }) {
    this.repo = repo;
    this.maxConcurrent = maxConcurrent;
    this.runTask = runTask;
    this.activeProjects = new Set();
    this.runningTasks = new Map();
  }

  get runningCount() {
    return this.runningTasks.size;
  }

  getRunningTaskIds() {
    return Array.from(this.runningTasks.keys());
  }

  kick() {
    while (this.runningCount < this.maxConcurrent) {
      const next = this.repo
        .listTasks('pending')
        .find((task) => task.project_id && !this.activeProjects.has(task.project_id));
      if (!next) return;
      this.activeProjects.add(next.project_id);
      this.runningTasks.set(next.id, next.project_id);
      Promise.resolve()
        .then(() => this.runTask(next))
        .catch(() => {
          // runTask owns persistence and error reporting
        })
        .finally(() => {
          this.runningTasks.delete(next.id);
          this.activeProjects.delete(next.project_id);
          this.kick();
        });
    }
  }
}

module.exports = ProjectScheduler;
