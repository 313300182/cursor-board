# cursor-board

个人看板工具，集成 Cursor Agent ACP，支持任务队列与自动审批。

## 快速开始

```bash
npm install
npm start
```

默认监听 `127.0.0.1:3920`，可在 `config.json` 中修改。

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm start` | 启动服务 |
| `npm test` | 运行测试 |
| `npm run deploy` | 部署看板服务 |

## 配置

- `config.json` — 服务端口、Cursor 模型、队列并发等
- `templates/` — 任务模板（feature、bugfix、refactor 等）
- `data/` — 运行时数据（已 gitignore，含 token 与数据库）

## 技术栈

Node.js · Express · SQLite (better-sqlite3)

## License

MIT · @author Amadeus
