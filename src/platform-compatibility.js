/**
 * Summarize platform-specific support without hiding runtime prerequisites.
 * @author Amadeus
 */
const { execFileSync } = require('node:child_process');

function detectRuntimeVersions(platform = process.platform) {
  const nodeVersion = process.version;
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm';
  let npmVersion = '';

  try {
    npmVersion = execFileSync(npmCommand, ['--version'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (error) {
    npmVersion = '';
  }

  return {
    nodeVersion,
    npmVersion,
    npmAvailable: Boolean(npmVersion),
  };
}

function getPlatformCompatibility(config, platform = process.platform, runtime = detectRuntimeVersions(platform)) {
  const allowlist = Array.isArray(config?.security?.workdirAllowlist)
    ? config.security.workdirAllowlist
    : [];
  const hasPosixWorkdir = allowlist.some((item) => String(item || '').trim().startsWith('/'));
  const nodeDetail = runtime.npmAvailable
    ? `Node.js ${runtime.nodeVersion} · npm ${runtime.npmVersion}`
    : `Node.js ${runtime.nodeVersion} · npm 未检测到`;

  return {
    current: platform,
    target: 'darwin',
    label: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform,
    runtime,
    items: [
      {
        id: 'node',
        name: 'Node.js / npm 运行时',
        available: true,
        detail: nodeDetail,
      },
      {
        id: 'agent',
        name: 'Cursor Agent / ACP',
        available: true,
        detail: '使用 agent acp，需先在 Mac 安装并登录 Cursor Agent',
      },
      {
        id: 'workspace',
        name: 'macOS 工作目录',
        available: hasPosixWorkdir,
        detail: hasPosixWorkdir
          ? '已配置 Unix 路径白名单'
          : '当前白名单只有 Windows 盘符，需加入 /Users/... 等路径',
      },
      {
        id: 'pipeline',
        name: '测试、Git 与部署流水线',
        available: true,
        detail: '使用 Node.js 子进程和系统 shell，可在 Mac 使用',
      },
      {
        id: 'background',
        name: 'Windows VBS 静默启动',
        available: false,
        detail: 'start-board.vbs 仅适用于 Windows；Mac 请使用 npm run start:bg 或 npm start',
      },
    ],
  };
}

module.exports = {
  detectRuntimeVersions,
  getPlatformCompatibility,
};
