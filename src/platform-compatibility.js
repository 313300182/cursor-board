/**
 * Summarize platform-specific support without hiding runtime prerequisites.
 * @author Amadeus
 */
function getPlatformCompatibility(config, platform = process.platform) {
  const allowlist = Array.isArray(config?.security?.workdirAllowlist)
    ? config.security.workdirAllowlist
    : [];
  const hasPosixWorkdir = allowlist.some((item) => String(item || '').trim().startsWith('/'));

  return {
    current: platform,
    target: 'darwin',
    label: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform,
    items: [
      {
        id: 'node',
        name: 'Node.js 前台启动',
        available: true,
        detail: 'npm start 可用',
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
  getPlatformCompatibility,
};
