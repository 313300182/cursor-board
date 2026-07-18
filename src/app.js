const path = require('path');
const express = require('express');
const { ROOT } = require('./config');
const { authMiddleware } = require('./middleware/auth');
const { errorHandler } = require('./middleware/error');
const { createAuthRouter } = require('./routes/auth');
const { createSystemRouter } = require('./routes/system');
const { createTemplatesRouter } = require('./routes/templates');
const { createProjectsRouter } = require('./routes/projects');
const { createTasksRouter } = require('./routes/tasks');
const { createChatsRouter } = require('./routes/chats');
const { createEventsRouter } = require('./routes/events');

function createApp(deps) {
  const {
    config,
    token,
    authService,
    repo,
    projects,
    queue,
    projectDeployer,
    chatService,
    broadcaster,
    root = ROOT,
  } = deps;

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(authMiddleware(authService || token));
  app.use(express.static(path.join(root, 'public')));

  const routeDeps = {
    config,
    token,
    authService,
    repo,
    projects,
    queue,
    projectDeployer,
    chatService,
    broadcaster,
    root,
  };

  app.use('/api/auth', createAuthRouter(routeDeps));
  app.use('/api', createSystemRouter(routeDeps));
  app.use('/api/templates', createTemplatesRouter());
  app.use('/api/projects', createProjectsRouter(routeDeps));
  app.use('/api/tasks', createTasksRouter(routeDeps));
  app.use('/api/chats', createChatsRouter(routeDeps));
  app.use('/api', createEventsRouter(routeDeps));

  app.use(errorHandler);

  return app;
}

module.exports = {
  createApp,
};
