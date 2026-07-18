const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeWorkdirs,
  buildCommitMessage,
  parsePorcelain,
  parseUntracked,
  parseDiff,
  collectWorkdirChanges,
  collectWorkdirChangeUnits,
  captureBaselineDirty,
  collectTaskUnits,
  toRepoRelative,
  commitSelected,
  commitSelectedUnits,
  commitTaskChanges,
} = require('../git-runner');

function fakeRunner(script) {
  const calls = [];
  const runner = async (args, options) => {
    calls.push({ args, cwd: options?.cwd, input: options?.input });
    const key = args[0];
    const handler = script[key];
    const value = typeof handler === 'function' ? handler(args, options) : handler;
    return value || { code: 0, stdout: '', stderr: '' };
  };
  runner.calls = calls;
  return runner;
}

const SAMPLE_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  'index 111..222 100644',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1,3 +1,3 @@',
  ' line1',
  '-old2',
  '+new2',
  ' line3',
  '@@ -10,2 +10,3 @@',
  ' x',
  '+added',
  ' y',
  '',
].join('\n');

test('normalizeWorkdirs 去重并回退到默认工作目录', () => {
  assert.deepEqual(normalizeWorkdirs([{ path: 'a' }, { path: 'a' }, 'b'], 'x'), ['a', 'b']);
  assert.deepEqual(normalizeWorkdirs([], '/repo'), ['/repo']);
  assert.deepEqual(normalizeWorkdirs(null, null), []);
});

test('buildCommitMessage 压缩空白并提供默认值', () => {
  assert.equal(buildCommitMessage('  修复\n登录  '), '修复 登录');
  assert.equal(buildCommitMessage(''), '自动提交：流水线任务变更');
});

test('commitTaskChanges 有变更时执行 add/commit 并可 push', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true\n', stderr: '' },
    status: { code: 0, stdout: ' M file.js\n', stderr: '' },
    add: { code: 0, stdout: '', stderr: '' },
    commit: { code: 0, stdout: 'ok', stderr: '' },
    push: { code: 0, stdout: '', stderr: '' },
  });

  const result = await commitTaskChanges({
    workdirs: [{ path: '/repo' }],
    taskTitle: '任务标题',
    push: true,
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.skipped, false);
  assert.equal(result.pushed, true);
  const commitCall = runner.calls.find((call) => call.args[0] === 'commit');
  assert.deepEqual(commitCall.args, ['commit', '-m', '任务标题']);
  assert.ok(runner.calls.some((call) => call.args[0] === 'push'));
});

test('commitTaskChanges 无变更时跳过提交', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true', stderr: '' },
    status: { code: 0, stdout: '', stderr: '' },
  });

  const result = await commitTaskChanges({ workdir: '/repo', runner });
  assert.equal(result.ok, true);
  assert.equal(result.committed, false);
  assert.equal(result.skipped, true);
  assert.ok(!runner.calls.some((call) => call.args[0] === 'commit'));
});

test('commitTaskChanges 提交失败时返回错误明细', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true', stderr: '' },
    status: { code: 0, stdout: ' M a.js', stderr: '' },
    add: { code: 0, stdout: '', stderr: '' },
    commit: { code: 1, stdout: '', stderr: 'nothing to commit' },
  });

  const result = await commitTaskChanges({ workdir: '/repo', runner });
  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.match(result.error, /nothing to commit/);
});

test('commitTaskChanges 非 git 仓库时视为无提交', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 128, stdout: '', stderr: 'not a git repository' },
  });

  const result = await commitTaskChanges({ workdir: '/tmp', runner });
  assert.equal(result.ok, true);
  assert.equal(result.committed, false);
  assert.equal(result.skipped, true);
});

test('parsePorcelain 解析变更路径并处理重命名', () => {
  const files = parsePorcelain(' M src/a.js\n?? src/b.js\nR  old.js -> new.js\n');
  assert.deepEqual(files, ['src/a.js', 'src/b.js', 'new.js']);
});

test('collectWorkdirChanges 返回各目录变更文件', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true', stderr: '' },
    status: { code: 0, stdout: ' M src/a.js\n?? src/b.js', stderr: '' },
  });
  const changes = await collectWorkdirChanges({ workdir: '/repo', runner });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].isRepo, true);
  assert.deepEqual(changes[0].files, ['src/a.js', 'src/b.js']);
});

test('commitSelected 仅暂存选定文件并用给定信息提交', async () => {
  const runner = fakeRunner({
    add: { code: 0, stdout: '', stderr: '' },
    commit: { code: 0, stdout: '', stderr: '' },
  });
  const result = await commitSelected({
    changes: [{ path: '/repo', isRepo: true, files: ['src/a.js', 'src/b.js', 'tmp.log'] }],
    files: ['src/a.js', 'src/b.js'],
    message: 'fix: 处理任务改动',
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  const addCall = runner.calls.find((call) => call.args[0] === 'add');
  assert.deepEqual(addCall.args, ['add', '--', 'src/a.js', 'src/b.js']);
  const commitCall = runner.calls.find((call) => call.args[0] === 'commit');
  assert.deepEqual(commitCall.args, ['commit', '-m', 'fix: 处理任务改动']);
});

test('commitSelected 选定文件与变更无交集时视为无提交', async () => {
  const runner = fakeRunner({});
  const result = await commitSelected({
    changes: [{ path: '/repo', isRepo: true, files: ['src/a.js'] }],
    files: ['other/x.js'],
    message: 'noop',
    runner,
  });
  assert.equal(result.ok, true);
  assert.equal(result.committed, false);
  assert.equal(result.skipped, true);
  assert.ok(!runner.calls.some((call) => call.args[0] === 'commit'));
});

test('parseUntracked 仅提取未跟踪文件', () => {
  assert.deepEqual(parseUntracked(' M a.js\n?? new.js\n?? dir/b.txt'), ['new.js', 'dir/b.txt']);
});

test('parseDiff 拆分文件与多个 hunk', () => {
  const files = parseDiff(SAMPLE_DIFF);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[0].hunks.length, 2);
  assert.match(files[0].hunks[0], /-old2/);
  assert.match(files[0].hunks[1], /\+added/);
});

test('collectWorkdirChangeUnits 生成 hunk 与文件级改动块', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true', stderr: '' },
    diff: { code: 0, stdout: SAMPLE_DIFF, stderr: '' },
    status: { code: 0, stdout: ' M src/a.js\n?? src/new.js', stderr: '' },
  });
  const { units, dirState } = await collectWorkdirChangeUnits({ workdir: '/repo', runner });
  assert.equal(dirState[0].isRepo, true);
  assert.equal(units.length, 3);
  assert.equal(units[0].kind, 'hunk');
  assert.equal(units[1].kind, 'hunk');
  assert.equal(units[2].kind, 'file');
  assert.equal(units[2].path, 'src/new.js');
});

test('commitSelectedUnits 只暂存选定 hunk 与文件后提交', async () => {
  const runner = fakeRunner({
    apply: { code: 0, stdout: '', stderr: '' },
    add: { code: 0, stdout: '', stderr: '' },
    commit: { code: 0, stdout: '', stderr: '' },
  });
  const units = [
    { id: 'C1', dir: '/repo', path: 'src/a.js', kind: 'hunk', fileHeader: 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js', hunk: '@@ -1,3 +1,3 @@\n line1\n-old2\n+new2\n line3', hunkIndex: 0 },
    { id: 'C2', dir: '/repo', path: 'src/a.js', kind: 'hunk', fileHeader: 'x', hunk: '@@ -10,2 +10,3 @@\n x\n+added\n y', hunkIndex: 1 },
    { id: 'C3', dir: '/repo', path: 'src/new.js', kind: 'file' },
  ];
  const result = await commitSelectedUnits({
    units,
    selectedIds: ['C1', 'C3'],
    message: 'fix: 只提交本任务改动',
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.ok(runner.calls.some((call) => call.args[0] === 'reset'), '应先重置 index 再暂存');
  const applyCall = runner.calls.find((call) => call.args[0] === 'apply');
  assert.ok(applyCall, 'should call git apply');
  assert.match(applyCall.input, /-old2/);
  assert.ok(!applyCall.input.includes('+added'), '未选中的 hunk 不应进入补丁');
  const addCall = runner.calls.find((call) => call.args[0] === 'add');
  assert.deepEqual(addCall.args, ['add', '--', 'src/new.js']);
  const commitCall = runner.calls.find((call) => call.args[0] === 'commit');
  assert.deepEqual(commitCall.args, ['commit', '-m', 'fix: 只提交本任务改动']);
});

test('commitSelectedUnits: apply 失败且文件全部 hunk 被选中时回退到文件级', async () => {
  const runner = fakeRunner({
    apply: { code: 1, stdout: '', stderr: 'patch does not apply' },
    add: { code: 0, stdout: '', stderr: '' },
    commit: { code: 0, stdout: '', stderr: '' },
  });
  const units = [
    { id: 'C1', dir: '/repo', path: 'src/a.js', kind: 'hunk', fileHeader: 'h', hunk: '@@ -1 +1 @@\n-a\n+b', hunkIndex: 0 },
    { id: 'C2', dir: '/repo', path: 'src/a.js', kind: 'hunk', fileHeader: 'h', hunk: '@@ -5 +5 @@\n-c\n+d', hunkIndex: 1 },
  ];
  const result = await commitSelectedUnits({
    units,
    selectedIds: ['C1', 'C2'],
    message: 'fix',
    runner,
  });
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.deepEqual(result.fallbacks, [{ dir: '/repo', path: 'src/a.js' }]);
  const addCall = runner.calls.find((call) => call.args[0] === 'add');
  assert.deepEqual(addCall.args, ['add', '--', 'src/a.js']);
});

test('commitSelectedUnits: apply 失败但仅选中部分 hunk 时拒绝回退', async () => {
  const runner = fakeRunner({
    apply: { code: 1, stdout: '', stderr: 'patch does not apply' },
    add: { code: 0, stdout: '', stderr: '' },
    commit: { code: 0, stdout: '', stderr: '' },
  });
  const units = [
    { id: 'C1', dir: '/repo', path: 'src/a.js', kind: 'hunk', fileHeader: 'h', hunk: '@@ -1 +1 @@\n-a\n+b', hunkIndex: 0 },
    { id: 'C2', dir: '/repo', path: 'src/a.js', kind: 'hunk', fileHeader: 'h', hunk: '@@ -5 +5 @@\n-c\n+d', hunkIndex: 1 },
  ];
  const result = await commitSelectedUnits({
    units,
    selectedIds: ['C1'],
    message: 'fix',
    runner,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /仅选中部分改动块/);
  assert.ok(!runner.calls.some((call) => call.args[0] === 'commit'));
});

test('toRepoRelative 仅返回目录内相对路径', () => {
  assert.equal(toRepoRelative('/repo', '/repo/src/a.js'), 'src/a.js');
  assert.equal(toRepoRelative('/repo', '/other/a.js'), null);
  assert.equal(toRepoRelative('/repo', ''), null);
});

test('captureBaselineDirty 记录各目录已有脏文件', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true' },
    status: { code: 0, stdout: ' M src/old.js\n?? tmp.txt\n' },
  });
  const baseline = await captureBaselineDirty({ workdir: '/repo', runner });
  assert.equal(baseline.length, 1);
  assert.equal(baseline[0].isRepo, true);
  assert.deepEqual(baseline[0].dirty, ['src/old.js', 'tmp.txt']);
});

test('captureBaselineDirty 非 git 仓库标记 isRepo=false', async () => {
  const runner = fakeRunner({ 'rev-parse': { code: 1, stdout: '' } });
  const baseline = await captureBaselineDirty({ workdir: '/plain', runner });
  assert.equal(baseline[0].isRepo, false);
  assert.deepEqual(baseline[0].dirty, []);
});

test('collectTaskUnits：新增全收、基线噪声跳过、编辑过的折叠', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true' },
    status: { code: 0, stdout: ' M src/old.js\n M src/edited.js\n M src/new.js\n' },
  });
  const baseline = [{ path: '/repo', isRepo: true, dirty: ['src/old.js', 'src/edited.js'] }];
  const editedPaths = ['/repo/src/edited.js'];
  const { units, diagnostics } = await collectTaskUnits({
    workdir: '/repo',
    baseline,
    editedPaths,
    runner,
  });
  const paths = units.map((unit) => unit.path).sort();
  assert.deepEqual(paths, ['src/edited.js', 'src/new.js']);
  assert.ok(units.every((unit) => unit.kind === 'file'));
  assert.deepEqual(diagnostics.skipped, ['src/old.js']);
  assert.deepEqual(diagnostics.folded, ['src/edited.js']);
});

test('collectTaskUnits：基线为空时全部改动都算本任务', async () => {
  const runner = fakeRunner({
    'rev-parse': { code: 0, stdout: 'true' },
    status: { code: 0, stdout: ' M a.js\n?? b.js\n' },
  });
  const { units, diagnostics } = await collectTaskUnits({ workdir: '/repo', runner });
  assert.deepEqual(units.map((unit) => unit.path).sort(), ['a.js', 'b.js']);
  assert.deepEqual(diagnostics.skipped, []);
  assert.deepEqual(diagnostics.folded, []);
});
