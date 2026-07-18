const fs = require('fs');
const path = require('path');

const token = fs.readFileSync(path.join(__dirname, '..', 'data', '.token'), 'utf8').trim();
const workdir = path.join(__dirname, '..');
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

async function main() {
  const projectsRes = await fetch('http://127.0.0.1:3920/api/projects', { headers });
  const projects = await projectsRes.json();
  let project = projects.find((item) => item.workdir?.toLowerCase() === workdir.toLowerCase());
  if (!project) {
    const projectRes = await fetch('http://127.0.0.1:3920/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Cursor Board', workdir }),
    });
    project = await projectRes.json();
    if (!projectRes.ok) throw new Error(project.error || '创建测试项目失败');
  }

  const createRes = await fetch('http://127.0.0.1:3920/api/tasks', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'MVP smoke test',
      template: 'general',
      projectId: project.id,
      isComplex: false,
      variables: {
        description: 'List files in current directory and reply with the count only',
      },
    }),
  });
  const task = await createRes.json();
  if (!createRes.ok) {
    console.error('CREATE_FAILED', task);
    process.exit(1);
  }
  console.log('CREATED', task.id, task.status);

  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`http://127.0.0.1:3920/api/tasks/${task.id}`, { headers });
    const current = await res.json();
    console.log('POLL', i, current.status);
    if (['done', 'failed', 'needs_human'].includes(current.status)) {
      console.log(JSON.stringify(current, null, 2));
      process.exit(current.status === 'done' ? 0 : 1);
    }
  }
  console.error('TIMEOUT');
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
