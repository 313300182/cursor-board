const { Cron } = require('croner');

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/**
 * 常驻任务调度器：cron 定时触发 + 手动立即触发，统一生成一次性任务入队。
 * 固定 Asia/Shanghai 时区，重启时按 cron 重算 next_run，croner 默认不补跑错过的点。
 * @author Amadeus
 */
class ScheduleScheduler {
  constructor({ scheduleRepo, projects, queue, broadcast, timezone = DEFAULT_TIMEZONE } = {}) {
    this.scheduleRepo = scheduleRepo;
    this.projects = projects;
    this.queue = queue;
    this.broadcast = typeof broadcast === 'function' ? broadcast : () => {};
    this.timezone = timezone;
    this.jobs = new Map();
  }

  start() {
    if (!this.scheduleRepo) return 0;
    for (const schedule of this.scheduleRepo.listAllEnabledCron()) {
      this.register(schedule);
    }
    return this.jobs.size;
  }

  stop() {
    for (const job of this.jobs.values()) {
      try {
        job.stop();
      } catch (_) {
        // ignore
      }
    }
    this.jobs.clear();
  }

  isValidCron(expr) {
    return this.computeNextRun(expr) !== null;
  }

  computeNextRun(expr) {
    const pattern = String(expr || '').trim();
    if (!pattern) return null;
    let job = null;
    try {
      job = new Cron(pattern, { timezone: this.timezone, paused: true });
      const next = job.nextRun();
      return next ? next.toISOString() : null;
    } catch (_) {
      return null;
    } finally {
      if (job) {
        try {
          job.stop();
        } catch (_) {
          // ignore
        }
      }
    }
  }

  unregister(id) {
    const job = this.jobs.get(id);
    if (job) {
      try {
        job.stop();
      } catch (_) {
        // ignore
      }
      this.jobs.delete(id);
    }
  }

  register(schedule) {
    if (!schedule) return null;
    this.unregister(schedule.id);
    if (schedule.trigger !== 'cron' || !schedule.enabled) return null;
    const pattern = String(schedule.cron_expr || '').trim();
    if (!pattern) return null;
    let job = null;
    try {
      job = new Cron(pattern, { timezone: this.timezone, catch: true }, () => {
        this.fire(schedule.id);
      });
    } catch (_) {
      return null;
    }
    this.jobs.set(schedule.id, job);
    const next = job.nextRun();
    if (this.scheduleRepo) {
      this.scheduleRepo.setNextRun(schedule.id, next ? next.toISOString() : null);
    }
    return job;
  }

  reconcileById(id) {
    const schedule = this.scheduleRepo ? this.scheduleRepo.get(id) : null;
    if (!schedule) {
      this.unregister(id);
      return null;
    }
    if (schedule.trigger === 'cron' && schedule.enabled) {
      this.register(schedule);
    } else {
      this.unregister(schedule.id);
      this.scheduleRepo.setNextRun(schedule.id, null);
    }
    return this.scheduleRepo.get(id);
  }

  fire(id) {
    if (!this.scheduleRepo) return null;
    const schedule = this.scheduleRepo.get(id);
    if (!schedule) return null;

    let task = null;
    let error = null;
    try {
      task = this.queue.createTask({
        projectId: schedule.project_id,
        template: schedule.template_id,
        variables: schedule.variables || {},
        workdirs: schedule.workdirs || [],
        sourceScheduleId: schedule.id,
      });
    } catch (err) {
      error = err && err.message ? err.message : String(err);
    }

    const patch = {
      last_run_at: new Date().toISOString(),
      last_status: error ? `失败：${error}` : 'ok',
    };
    if (task) patch.last_task_id = task.id;
    const job = this.jobs.get(id);
    if (job) {
      const next = job.nextRun();
      patch.next_run_at = next ? next.toISOString() : null;
    }
    const updated = this.scheduleRepo.recordRun(id, patch);
    this.broadcast('schedule:run', updated);
    if (error) {
      console.warn(`[schedule] 常驻任务触发失败 ${schedule.name}: ${error}`);
    }
    return { schedule: updated, task, error };
  }

  triggerNow(id) {
    return this.fire(id);
  }
}

module.exports = ScheduleScheduler;
module.exports.DEFAULT_TIMEZONE = DEFAULT_TIMEZONE;
