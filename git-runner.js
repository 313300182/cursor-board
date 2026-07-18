const { spawn } = require('child_process');
const path = require('path');

/**
 * Run git directly via child_process without a shell.
 * Avoids PowerShell quoting / `&&` / encoding pitfalls on Windows.
 * @author Amadeus
 */
function runGit(args, { cwd, timeoutMs = 120000, input } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    try {
      if (input != null) child.stdin.write(input);
      child.stdin.end();
    } catch {
      // ignore stdin write failures (e.g. command does not read stdin)
    }
    child.stdin.on('error', () => {});
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish({ code: null, stdout, stderr: `${stderr}\n[git 超时 ${timeoutMs}ms]`, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (data) => { stdout += data.toString('utf8'); });
    child.stderr.on('data', (data) => { stderr += data.toString('utf8'); });
    child.on('error', (error) => {
      finish({ code: null, stdout, stderr: `${stderr}${error?.message || error}`, error });
    });
    child.on('close', (code) => {
      finish({ code, stdout, stderr });
    });
  });
}

function normalizeWorkdirs(workdirs, fallback) {
  const paths = [];
  for (const entry of Array.isArray(workdirs) ? workdirs : []) {
    const path = typeof entry === 'string' ? entry : entry?.path;
    if (path) paths.push(path);
  }
  if (!paths.length && fallback) paths.push(fallback);
  return [...new Set(paths)];
}

function buildCommitMessage(taskTitle) {
  const title = String(taskTitle || '').replace(/\s+/g, ' ').trim();
  return title || '自动提交：流水线任务变更';
}

function parsePorcelain(stdout) {
  const files = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const entry = raw.slice(3);
    const arrow = entry.indexOf(' -> ');
    files.push((arrow >= 0 ? entry.slice(arrow + 4) : entry).trim());
  }
  return files;
}

async function collectWorkdirChanges({ workdirs = [], workdir, runner = runGit } = {}) {
  const dirs = normalizeWorkdirs(workdirs, workdir);
  const changes = [];
  for (const dir of dirs) {
    const inside = await runner(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (inside.code !== 0 || !/true/.test(inside.stdout)) {
      changes.push({ path: dir, isRepo: false, files: [] });
      continue;
    }
    const status = await runner(['status', '--porcelain'], { cwd: dir });
    if (status.code !== 0) {
      changes.push({ path: dir, isRepo: true, files: [], error: (status.stderr || status.stdout).trim() });
      continue;
    }
    changes.push({ path: dir, isRepo: true, files: parsePorcelain(status.stdout) });
  }
  return changes;
}

async function commitSelected({
  changes = [],
  files = [],
  message,
  push = false,
  runner = runGit,
} = {}) {
  const selected = files.length ? new Set(files) : null;
  const commitMessage = buildCommitMessage(message);
  const results = [];

  for (const change of changes) {
    if (!change.isRepo) {
      results.push({ path: change.path, status: 'not_repo' });
      continue;
    }
    if (change.error) {
      results.push({ path: change.path, status: 'error', error: change.error });
      continue;
    }
    const toStage = selected ? change.files.filter((file) => selected.has(file)) : change.files;
    if (!toStage.length) {
      results.push({ path: change.path, status: 'clean' });
      continue;
    }

    const add = await runner(['add', '--', ...toStage], { cwd: change.path });
    if (add.code !== 0) {
      results.push({ path: change.path, status: 'error', error: (add.stderr || add.stdout).trim() });
      continue;
    }
    const commit = await runner(['commit', '-m', commitMessage], { cwd: change.path });
    if (commit.code !== 0) {
      results.push({ path: change.path, status: 'error', error: (commit.stderr || commit.stdout).trim() });
      continue;
    }

    const result = { path: change.path, status: 'committed' };
    if (push) {
      const pushed = await runner(['push'], { cwd: change.path });
      if (pushed.code !== 0) {
        results.push({ path: change.path, status: 'error', error: `commit 成功但 push 失败: ${(pushed.stderr || pushed.stdout).trim()}` });
        continue;
      }
      result.pushed = true;
    }
    results.push(result);
  }

  const errors = results.filter((item) => item.status === 'error');
  if (errors.length) {
    return {
      ok: false,
      committed: false,
      skipped: false,
      error: errors.map((item) => `${item.path}: ${item.error}`).join('\n'),
      results,
    };
  }
  const committed = results.some((item) => item.status === 'committed');
  return {
    ok: true,
    committed,
    skipped: !committed,
    pushed: results.some((item) => item.pushed),
    error: null,
    results,
  };
}

async function commitWorkdir(workdir, { message, push, runner }) {
  const inside = await runner(['rev-parse', '--is-inside-work-tree'], { cwd: workdir });
  if (inside.code !== 0 || !/true/.test(inside.stdout)) {
    return { path: workdir, status: 'not_repo' };
  }

  const status = await runner(['status', '--porcelain'], { cwd: workdir });
  if (status.code !== 0) {
    return { path: workdir, status: 'error', error: (status.stderr || status.stdout).trim() };
  }
  if (!status.stdout.trim()) {
    return { path: workdir, status: 'clean' };
  }

  const add = await runner(['add', '-A'], { cwd: workdir });
  if (add.code !== 0) {
    return { path: workdir, status: 'error', error: (add.stderr || add.stdout).trim() };
  }

  const commit = await runner(['commit', '-m', message], { cwd: workdir });
  if (commit.code !== 0) {
    return { path: workdir, status: 'error', error: (commit.stderr || commit.stdout).trim() };
  }

  const result = { path: workdir, status: 'committed' };
  if (push) {
    const pushed = await runner(['push'], { cwd: workdir });
    if (pushed.code !== 0) {
      return { path: workdir, status: 'error', error: `commit 成功但 push 失败: ${(pushed.stderr || pushed.stdout).trim()}` };
    }
    result.pushed = true;
  }
  return result;
}

async function commitTaskChanges({
  workdirs = [],
  workdir,
  taskTitle = '',
  push = false,
  runner = runGit,
} = {}) {
  const dirs = normalizeWorkdirs(workdirs, workdir);
  const message = buildCommitMessage(taskTitle);
  const results = [];
  for (const dir of dirs) {
    results.push(await commitWorkdir(dir, { message, push, runner }));
  }

  const errors = results.filter((item) => item.status === 'error');
  if (errors.length) {
    return {
      ok: false,
      committed: false,
      skipped: false,
      error: errors.map((item) => `${item.path}: ${item.error}`).join('\n'),
      results,
    };
  }

  const committed = results.some((item) => item.status === 'committed');
  return {
    ok: true,
    committed,
    skipped: !committed,
    pushed: results.some((item) => item.pushed),
    error: null,
    results,
  };
}

function extractDiffPath(diffHeaderLine) {
  const match = diffHeaderLine.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (match) return match[2];
  return diffHeaderLine.replace(/^diff --git /, '').trim();
}

function parseDiff(diffText) {
  const files = [];
  const lines = String(diffText || '').split('\n');
  let current = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      current = { path: extractDiffPath(line), header: [line], hunks: [], binary: false };
      files.push(current);
      i += 1;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        if (/^Binary files /.test(lines[i]) || /^GIT binary patch/.test(lines[i])) {
          current.binary = true;
        }
        current.header.push(lines[i]);
        i += 1;
      }
      continue;
    }
    if (line.startsWith('@@') && current) {
      const hunkLines = [line];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git ')) {
        hunkLines.push(lines[i]);
        i += 1;
      }
      current.hunks.push(hunkLines.join('\n'));
      continue;
    }
    i += 1;
  }
  return files;
}

function parseUntracked(stdout) {
  const files = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    if (raw.startsWith('?? ')) files.push(raw.slice(3).trim());
  }
  return files;
}

async function collectWorkdirChangeUnits({ workdirs = [], workdir, runner = runGit } = {}) {
  const dirs = normalizeWorkdirs(workdirs, workdir);
  const units = [];
  const dirState = [];
  let seq = 0;
  for (const dir of dirs) {
    const inside = await runner(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (inside.code !== 0 || !/true/.test(inside.stdout)) {
      dirState.push({ path: dir, isRepo: false });
      continue;
    }
    // Diff against HEAD so any changes already staged (e.g. an agent that ran
    // `git add` during dev) are also captured as selectable hunks. Fall back to
    // the plain working-tree diff for repos without a HEAD commit yet.
    let diff = await runner(['diff', '--no-color', 'HEAD'], { cwd: dir });
    if (diff.code !== 0) {
      diff = await runner(['diff', '--no-color'], { cwd: dir });
    }
    if (diff.code !== 0) {
      dirState.push({ path: dir, isRepo: true, error: (diff.stderr || diff.stdout).trim() });
      continue;
    }
    const status = await runner(['status', '--porcelain'], { cwd: dir });
    if (status.code !== 0) {
      dirState.push({ path: dir, isRepo: true, error: (status.stderr || status.stdout).trim() });
      continue;
    }
    dirState.push({ path: dir, isRepo: true });

    for (const file of parseDiff(diff.stdout)) {
      if (file.binary || !file.hunks.length) {
        units.push({ id: `C${(seq += 1)}`, dir, path: file.path, kind: 'file' });
        continue;
      }
      file.hunks.forEach((hunk, hunkIndex) => {
        units.push({
          id: `C${(seq += 1)}`,
          dir,
          path: file.path,
          kind: 'hunk',
          fileHeader: file.header.join('\n'),
          hunk,
          hunkIndex,
        });
      });
    }
    for (const path of parseUntracked(status.stdout)) {
      units.push({ id: `C${(seq += 1)}`, dir, path, kind: 'file' });
    }
  }
  return { units, dirState };
}

function countHunksByPath(units) {
  const counts = new Map();
  for (const unit of units) {
    if (unit.kind !== 'hunk') continue;
    counts.set(unit.path, (counts.get(unit.path) || 0) + 1);
  }
  return counts;
}

async function stageUnitsForDir(dir, selectedList, dirTotals, runner) {
  const hunkUnits = selectedList.filter((unit) => unit.kind === 'hunk');
  const fileUnits = selectedList.filter((unit) => unit.kind === 'file');
  const fallbacks = [];

  // Reset the index to HEAD first so the commit contains ONLY what we stage
  // below. Hunks were computed against HEAD, so applying them to a clean index
  // is exact. Best-effort: repos without HEAD (no commit) simply have nothing
  // to unstage. Working tree is untouched by a mixed reset.
  await runner(['reset', '-q'], { cwd: dir });

  if (hunkUnits.length) {
    const byPath = new Map();
    for (const unit of hunkUnits) {
      if (!byPath.has(unit.path)) byPath.set(unit.path, { header: unit.fileHeader, hunks: [] });
      byPath.get(unit.path).hunks.push(unit);
    }
    let patch = '';
    for (const { header, hunks } of byPath.values()) {
      hunks.sort((a, b) => a.hunkIndex - b.hunkIndex);
      patch += `${header}\n${hunks.map((item) => item.hunk).join('\n')}\n`;
    }
    const applied = await runner(['apply', '--cached', '--recount', '--whitespace=nowarn'], { cwd: dir, input: patch });
    if (applied.code !== 0) {
      const applyError = (applied.stderr || applied.stdout).trim();
      // Fallback to file-level staging, but ONLY for files where every hunk was
      // selected — then whole-file staging is equivalent to the AI's hunk choice
      // and (given directory serialization) cannot pull in another task's changes.
      for (const [path, group] of byPath) {
        const selectedHunks = group.hunks.length;
        const totalHunks = dirTotals.get(path) || selectedHunks;
        if (selectedHunks !== totalHunks) {
          return {
            ok: false,
            error: `git apply 失败，且文件 ${path} 仅选中部分改动块（${selectedHunks}/${totalHunks}），`
              + `无法安全回退到文件级提交（会误提交未选中的改动）。原始错误: ${applyError}`,
          };
        }
        const add = await runner(['add', '--', path], { cwd: dir });
        if (add.code !== 0) {
          return { ok: false, error: (add.stderr || add.stdout).trim() };
        }
        fallbacks.push(path);
      }
    }
  }

  for (const unit of fileUnits) {
    const add = await runner(['add', '--', unit.path], { cwd: dir });
    if (add.code !== 0) {
      return { ok: false, error: (add.stderr || add.stdout).trim() };
    }
  }
  return { ok: true, fallbacks };
}

async function commitSelectedUnits({
  units = [],
  selectedIds = [],
  message,
  push = false,
  runner = runGit,
} = {}) {
  const selected = new Set(selectedIds);
  const chosen = units.filter((unit) => selected.has(unit.id));
  const byDir = new Map();
  const totalsByDir = new Map();
  for (const unit of units) {
    if (!totalsByDir.has(unit.dir)) totalsByDir.set(unit.dir, []);
    totalsByDir.get(unit.dir).push(unit);
  }
  for (const unit of chosen) {
    if (!byDir.has(unit.dir)) byDir.set(unit.dir, []);
    byDir.get(unit.dir).push(unit);
  }

  const commitMessage = buildCommitMessage(message);
  const results = [];
  const fallbacks = [];
  for (const [dir, list] of byDir) {
    const dirTotals = countHunksByPath(totalsByDir.get(dir) || []);
    const staged = await stageUnitsForDir(dir, list, dirTotals, runner);
    if (!staged.ok) {
      results.push({ path: dir, status: 'error', error: staged.error });
      continue;
    }
    if (staged.fallbacks?.length) {
      fallbacks.push(...staged.fallbacks.map((path) => ({ dir, path })));
    }
    const commit = await runner(['commit', '-m', commitMessage], { cwd: dir });
    if (commit.code !== 0) {
      results.push({ path: dir, status: 'error', error: (commit.stderr || commit.stdout).trim() });
      continue;
    }
    const result = { path: dir, status: 'committed' };
    if (push) {
      const pushed = await runner(['push'], { cwd: dir });
      if (pushed.code !== 0) {
        results.push({ path: dir, status: 'error', error: `commit 成功但 push 失败: ${(pushed.stderr || pushed.stdout).trim()}` });
        continue;
      }
      result.pushed = true;
    }
    results.push(result);
  }

  const errors = results.filter((item) => item.status === 'error');
  if (errors.length) {
    return {
      ok: false,
      committed: false,
      skipped: false,
      error: errors.map((item) => `${item.path}: ${item.error}`).join('\n'),
      results,
    };
  }
  const committed = results.some((item) => item.status === 'committed');
  return {
    ok: true,
    committed,
    skipped: !committed,
    pushed: results.some((item) => item.pushed),
    error: null,
    results,
    fallbacks,
  };
}

function normalizeComparePath(value) {
  const normalized = String(value || '').split('\\').join('/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toRepoRelative(dir, absPath) {
  if (!absPath) return null;
  const rel = path.relative(dir, String(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Snapshot which files are already dirty in each workdir. Captured right after
 * the directory lock is acquired (before the task writes anything) so the
 * commit phase can tell the task's own changes apart from pre-existing noise.
 * @author Amadeus
 */
async function captureBaselineDirty({ workdirs = [], workdir, runner = runGit } = {}) {
  const dirs = normalizeWorkdirs(workdirs, workdir);
  const baseline = [];
  for (const dir of dirs) {
    const inside = await runner(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (inside.code !== 0 || !/true/.test(inside.stdout)) {
      baseline.push({ path: dir, isRepo: false, dirty: [] });
      continue;
    }
    const status = await runner(['status', '--porcelain'], { cwd: dir });
    if (status.code !== 0) {
      baseline.push({ path: dir, isRepo: true, dirty: [], error: (status.stderr || status.stdout).trim() });
      continue;
    }
    baseline.push({ path: dir, isRepo: true, dirty: parsePorcelain(status.stdout) });
  }
  return baseline;
}

/**
 * Deterministically pick the files that belong to THIS task, combining:
 *   D) baseline diff  — files that became dirty during execution (not dirty at
 *      baseline) are the task's, since the directory lock forbids other writers.
 *   G) edited paths   — files the agent's edit tool-calls touched are the task's
 *      even if they were already dirty at baseline (whole file is folded in).
 * Files that were dirty at baseline and the agent did NOT edit are treated as
 * pre-existing noise and skipped. Returns file-level units ready for
 * {@link commitSelectedUnits}.
 * @author Amadeus
 */
async function collectTaskUnits({ workdirs = [], workdir, baseline = [], editedPaths = [], runner = runGit } = {}) {
  const dirs = normalizeWorkdirs(workdirs, workdir);
  const baselineByDir = new Map();
  for (const entry of baseline) {
    baselineByDir.set(entry.path, new Set((entry.dirty || []).map(normalizeComparePath)));
  }
  const units = [];
  const dirState = [];
  const skipped = [];
  const folded = [];
  let seq = 0;
  for (const dir of dirs) {
    const inside = await runner(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (inside.code !== 0 || !/true/.test(inside.stdout)) {
      dirState.push({ path: dir, isRepo: false });
      continue;
    }
    const status = await runner(['status', '--porcelain'], { cwd: dir });
    if (status.code !== 0) {
      dirState.push({ path: dir, isRepo: true, error: (status.stderr || status.stdout).trim() });
      continue;
    }
    dirState.push({ path: dir, isRepo: true });

    const baselineDirty = baselineByDir.get(dir) || new Set();
    const editedRel = new Set();
    for (const abs of editedPaths) {
      const rel = toRepoRelative(dir, abs);
      if (rel) editedRel.add(normalizeComparePath(rel));
    }

    for (const file of parsePorcelain(status.stdout)) {
      const key = normalizeComparePath(file);
      const wasDirty = baselineDirty.has(key);
      const wasEdited = editedRel.has(key);
      if (!wasDirty) {
        units.push({ id: `C${(seq += 1)}`, dir, path: file, kind: 'file' });
      } else if (wasEdited) {
        units.push({ id: `C${(seq += 1)}`, dir, path: file, kind: 'file' });
        folded.push(file);
      } else {
        skipped.push(file);
      }
    }
  }
  return { units, dirState, diagnostics: { skipped, folded } };
}

module.exports = {
  runGit,
  normalizeWorkdirs,
  buildCommitMessage,
  parsePorcelain,
  parseUntracked,
  parseDiff,
  toRepoRelative,
  collectWorkdirChanges,
  collectWorkdirChangeUnits,
  captureBaselineDirty,
  collectTaskUnits,
  commitSelected,
  commitSelectedUnits,
  commitTaskChanges,
};
