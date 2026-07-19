#!/usr/bin/env node
/**
 * UI 视觉自检脚本：给 Agent 一双"眼睛"。
 *
 * 默认零副作用地拉起一个内存实例（临时 SQLite + 预置样例数据 + 免登录 token），
 * 用 Playwright(Chromium) 无头访问首页与看板，输出整页截图 + DOM 体检报告
 * （嵌套滚动条 / 横向溢出 / 控制台报错），供 Agent 读图自纠。
 *
 * 用法：
 *   node scripts/ui-shot.js                       # 内存实例 + 预置数据（推荐）
 *   node scripts/ui-shot.js --width 1280          # 指定视口宽度
 *   node scripts/ui-shot.js --url http://127.0.0.1:3920 --token <t>  # 截真实运行中的看板
 *
 * @author Amadeus
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const Database = require('better-sqlite3');
const { chromium } = require('playwright');

const {
  ensureSchema,
  createProjectRepo,
  createTaskRepo,
  createChatRepo,
  createProjectTemplateRepo,
  createScheduleRepo,
} = require('../db');
const ChatService = require('../chat-service');
const { createTemplateService } = require('../template-service');
const { createApp } = require('../src/app');
const { ROOT, TOKEN_PATH } = require('../src/config');
const { createBroadcaster } = require('../src/sse/broadcaster');

function parseArgs(argv) {
  const args = { width: 1440, height: 960, out: path.join(ROOT, '.ui-shots') };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--width') { args.width = Number(next) || args.width; i += 1; }
    else if (key === '--height') { args.height = Number(next) || args.height; i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
    else if (key === '--url') { args.url = String(next || '').replace(/\/$/, ''); i += 1; }
    else if (key === '--token') { args.token = String(next || ''); i += 1; }
    else if (key === '--project') { args.project = String(next || ''); i += 1; }
  }
  return args;
}

const nowIso = () => new Date().toISOString();
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

/** 预置一组覆盖各看板列的样例任务，让页面在无真实数据时也有真实布局。 */
function seedSampleData(repo, projects) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-uishot-'));
  const project = projects.createProject({
    id: 'ui-shot-demo',
    name: 'UI 自检样例项目',
    type: 'normal',
    workdir,
    deploy_command: 'npm run deploy',
    git_enabled: 1,
    created_at: minutesAgo(600),
  });

  const samples = [
    { status: 'pending', title: '重构登录鉴权中间件', complex: true },
    { status: 'pending', title: '修复导出 CSV 的编码问题' },
    { status: 'pending', title: '给设置页补充暗色主题', complex: true },
    { status: 'developing', title: '接入 Playwright 视觉自检', complex: true },
    { status: 'planning', title: '拆分超长的 index.html' },
    { status: 'testing', title: '为队列补充并发单测' },
    { status: 'awaiting_input', title: '确认数据库迁移方案' },
    { status: 'pending_approval', title: '批准生产环境部署' },
    { status: 'pending_deploy', title: '看板样式统一（已构建）', complex: true },
    { status: 'deploying', title: '发布 v0.4.2' },
    { status: 'done', title: '统一校验逻辑到 shared 模块', complex: true },
    { status: 'done', title: '修复双滚动条布局问题' },
    { status: 'done', title: '首页项目卡片信息密度优化' },
    { status: 'failed', title: '同步远端分支时冲突' },
    { status: 'needs_human', title: '第三方接口返回异常需人工介入' },
  ];

  samples.forEach((s, i) => {
    repo.createTask({
      id: `ui-shot-task-${i + 1}`,
      project_id: project.id,
      title: s.title,
      template: 'general',
      variables: {},
      attachments: [],
      workdir,
      workdirs: [{ label: '', path: workdir }],
      status: s.status,
      is_complex: s.complex ? 1 : 0,
      pipeline_mode: s.complex ? 1 : 0,
      git_commit: 1,
      model_id: s.complex ? 'opus-demo' : 'gpt-demo',
      prompt_rendered: `请完成任务：${s.title}`,
      parent_task_id: null,
      source_schedule_id: null,
      created_at: minutesAgo(samples.length - i),
    });
  });

  return { project, workdir };
}

/** 组装一个内存版应用（复用真实路由，mock 掉会真正跑 agent 的副作用依赖）。 */
function buildEphemeralApp() {
  const db = new Database(':memory:');
  ensureSchema(db);
  const repo = createTaskRepo(db);
  const chatRepo = createChatRepo(db);
  const projects = createProjectRepo(db);
  const projectTemplates = createProjectTemplateRepo(db);
  const scheduleRepo = createScheduleRepo(db);
  const templateService = createTemplateService({ projectTemplates });
  projects.ensureMachineProject();

  const { project, workdir } = seedSampleData(repo, projects);

  const token = crypto.randomBytes(16).toString('hex');
  const authService = {
    getToken: () => token,
    verifyToken: (candidate) => candidate === token,
    login: (password) => (password === '123456'
      ? { ok: true, token }
      : { ok: false, locked: false }),
    changePassword: () => ({ ok: false, locked: false }),
  };

  const config = {
    server: { host: '127.0.0.1', port: 0 },
    security: { workdirAllowlist: ['D:\\', 'C:\\', workdir] },
    queue: { maxConcurrent: 3 },
    cursor: {
      models: {
        simpleDefault: 'gpt-demo',
        complexDefault: 'opus-demo',
        options: [
          { id: 'gpt-demo', name: 'GPT Demo' },
          { id: 'opus-demo', name: 'Opus Demo' },
        ],
      },
    },
  };

  const broadcaster = createBroadcaster();
  const runnerStub = {
    isTaskRunning: () => false,
    runChatTurn: async () => ({ resultSummary: 'mock', sessionId: 'mock' }),
    submitInteraction: async () => {},
    cancelTask: () => {},
  };
  const chatService = new ChatService({
    chatRepo,
    projects,
    config,
    broadcast: (event, data) => broadcaster.send(event, data),
    runner: runnerStub,
  });
  const queue = {
    currentTaskId: null,
    runningTaskIds: [],
    running: false,
    isWorkdirAllowed: () => true,
    createTask: () => { throw new Error('ui-shot: queue is read-only'); },
    runner: runnerStub,
  };
  const projectDeployer = {
    deployProject: async () => { throw new Error('ui-shot: deploy disabled'); },
    approveRepair: async () => { throw new Error('ui-shot: repair disabled'); },
  };
  const scheduleScheduler = { start: () => 0, refreshSchedule: () => {}, removeSchedule: () => {} };

  const app = createApp({
    config,
    authService,
    repo,
    projects,
    queue,
    projectDeployer,
    chatService,
    broadcaster,
    projectTemplates,
    scheduleRepo,
    templateService,
    scheduleScheduler,
    root: ROOT,
  });

  return { app, token, projectId: project.id, cleanup: () => { try { db.close(); } catch { /* ignore */ } fs.rmSync(workdir, { recursive: true, force: true }); } };
}

/** 在页面内做 DOM 体检：嵌套滚动容器、横向溢出。 */
const AUDIT_FN = () => {
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let seg = node.tagName.toLowerCase();
      if (node.id) { seg += `#${node.id}`; parts.unshift(seg); break; }
      if (node.className && typeof node.className === 'string') {
        const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) seg += `.${cls}`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };

  const scrollers = [];
  document.querySelectorAll('*').forEach((el) => {
    const style = getComputedStyle(el);
    const oy = style.overflowY;
    const scrollable = (oy === 'auto' || oy === 'scroll')
      && el.scrollHeight - el.clientHeight > 4
      && el.clientHeight > 0;
    if (scrollable) {
      const rect = el.getBoundingClientRect();
      scrollers.push({
        selector: cssPath(el),
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
  });

  // 文字重叠检测：同一父级下的兄弟元素矩形互相压盖（常见于 flex 间距失效/负边距）
  const overlaps = [];
  const seen = new Set();
  const hasText = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) return true;
    }
    return false;
  };
  document.querySelectorAll('*').forEach((parent) => {
    const kids = Array.from(parent.children).filter((el) => {
      const s = getComputedStyle(el);
      if (s.position === 'absolute' || s.position === 'fixed') return false;
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i].getBoundingClientRect();
        const b = kids[j].getBoundingClientRect();
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 2 && oy > 2 && (hasText(kids[i]) || hasText(kids[j]))) {
          const key = `${cssPath(kids[i])}|${cssPath(kids[j])}`;
          if (seen.has(key)) continue;
          seen.add(key);
          overlaps.push({
            a: cssPath(kids[i]),
            b: cssPath(kids[j]),
            overlap: { x: Math.round(ox), y: Math.round(oy) },
            textA: (kids[i].textContent || '').trim().slice(0, 24),
            textB: (kids[j].textContent || '').trim().slice(0, 24),
          });
        }
      }
    }
  });

  const doc = document.documentElement;
  const horizontalOverflow = doc.scrollWidth - doc.clientWidth > 2;

  return {
    scrollerCount: scrollers.length,
    scrollers,
    overlapCount: overlaps.length,
    overlaps: overlaps.slice(0, 20),
    horizontalOverflow,
    docScrollWidth: doc.scrollWidth,
    docClientWidth: doc.clientWidth,
  };
};

async function capture(page, baseUrl, token, target) {
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err && err.message || err)));

  await page.addInitScript((t) => {
    try { localStorage.setItem('cursorBoardToken', t); } catch { /* ignore */ }
  }, token);

  await page.goto(`${baseUrl}${target.pathAndQuery}`, { waitUntil: 'load', timeout: 20000 });
  try {
    if (target.waitFor) await page.waitForSelector(target.waitFor, { timeout: 8000 });
  } catch { /* 允许缺省，仍然截图便于排查 */ }
  await page.waitForTimeout(500);

  for (const step of (target.actions || [])) {
    try {
      if (step.click) await page.click(step.click, { timeout: 6000 });
      if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout: 6000 });
    } catch { /* 步骤失败仍截图便于排查 */ }
  }
  await page.waitForTimeout(400);

  const audit = await page.evaluate(AUDIT_FN);
  return { consoleErrors, audit };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });

  let baseUrl = args.url;
  let token = args.token;
  let projectId = args.project;
  let server = null;
  let ephemeral = null;

  if (!baseUrl) {
    ephemeral = buildEphemeralApp();
    token = ephemeral.token;
    projectId = ephemeral.projectId;
    await new Promise((resolve) => {
      server = ephemeral.app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  } else if (!token) {
    try { token = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch { /* ignore */ }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });

  const targets = [
    { name: 'home', pathAndQuery: '/', waitFor: '#homeView, .project-grid' },
  ];
  if (projectId) {
    const boardQuery = `/?project=${encodeURIComponent(projectId)}`;
    targets.push({
      name: 'board',
      pathAndQuery: boardQuery,
      waitFor: '.board .column',
    });
    targets.push({
      name: 'create-task',
      pathAndQuery: boardQuery,
      waitFor: '.board .column',
      clipSelector: '#templatePicker',
      actions: [
        { click: '#openCreateTaskBtn', waitFor: '#createTaskModal:not(.hidden)' },
        { click: '#templateSection > summary', waitFor: '.template-card' },
      ],
    });
  }

  const report = {
    generatedAt: nowIso(),
    baseUrl,
    mode: ephemeral ? 'ephemeral' : 'live',
    viewport: { width: args.width, height: args.height },
    pages: [],
  };

  for (const target of targets) {
    const page = await context.newPage();
    const { consoleErrors, audit } = await capture(page, baseUrl, token, target);
    const file = path.join(args.out, `${target.name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    let clip = null;
    if (target.clipSelector) {
      try {
        const el = await page.$(target.clipSelector);
        if (el) {
          clip = path.join(args.out, `${target.name}-clip.png`);
          await el.screenshot({ path: clip });
        }
      } catch { /* 元素特写失败不阻断 */ }
    }
    await page.close();
    report.pages.push({
      name: target.name,
      screenshot: file,
      clip,
      consoleErrors,
      audit,
    });
  }

  await context.close();
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (ephemeral) ephemeral.cleanup();

  const reportPath = path.join(args.out, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  console.log('=== UI 视觉自检完成 ===');
  console.log(`模式: ${report.mode}  视口: ${args.width}x${args.height}`);
  for (const p of report.pages) {
    const flags = [];
    if (p.audit.horizontalOverflow) flags.push('横向溢出!');
    if (p.audit.scrollerCount > 1) flags.push(`嵌套滚动条x${p.audit.scrollerCount}`);
    if (p.audit.overlapCount) flags.push(`文字重叠x${p.audit.overlapCount}`);
    if (p.consoleErrors.length) flags.push(`控制台错误x${p.consoleErrors.length}`);
    const status = flags.length ? flags.join(' / ') : 'OK';
    console.log(`- [${p.name}] ${p.screenshot}  => ${status}`);
    if (p.audit.scrollerCount > 1) {
      p.audit.scrollers.forEach((s) => console.log(`    · 滚动容器 ${s.selector} (${s.clientHeight}/${s.scrollHeight})`));
    }
    (p.audit.overlaps || []).forEach((o) => console.log(`    · 重叠 [${o.textA}] × [${o.textB}] @ ${o.a}`));
    p.consoleErrors.slice(0, 5).forEach((e) => console.log(`    ! ${e}`));
  }
  console.log(`报告: ${reportPath}`);
  console.log('');
}

main().catch((err) => {
  console.error('ui-shot 失败:', err);
  process.exit(1);
});
