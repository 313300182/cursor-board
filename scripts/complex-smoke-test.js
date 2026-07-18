const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const token = fs.readFileSync(path.join(root, 'data', '.token'), 'utf8').trim();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const baseUrl = 'http://127.0.0.1:3920';
const outputPath = path.join(root, 'data', 'complex-smoke-output.txt');

async function request(url, options = {}) {
  const response = await fetch(baseUrl + url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function main() {
  const projects = await request('/api/projects');
  const project = projects.find((item) => item.workdir?.toLowerCase() === root.toLowerCase());
  if (!project) throw new Error('请先运行普通 smoke test 创建 Cursor Board 项目');

  const task = await request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      title: 'Complex smoke test',
      template: 'general',
      isComplex: true,
      variables: {
        description: '先制定计划，批准后在 data/complex-smoke-output.txt 写入 COMPLEX_OK，然后汇报完成',
      },
    }),
  });
  console.log('CREATED', task.id);

  for (let i = 0; i < 90; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const current = await request(`/api/tasks/${task.id}`);
    console.log('POLL', i, current.status);
    if (current.status === 'pending_approval') {
      await request(`/api/tasks/${task.id}/interaction`, {
        method: 'POST',
        body: JSON.stringify({ accepted: true }),
      });
      console.log('PLAN_ACCEPTED');
    } else if (current.status === 'awaiting_input') {
      const answers = current.interaction.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: [question.options[0].id],
      }));
      await request(`/api/tasks/${task.id}/interaction`, {
        method: 'POST',
        body: JSON.stringify({ answers }),
      });
      console.log('QUESTION_ANSWERED');
    } else if (['done', 'failed', 'needs_human'].includes(current.status)) {
      console.log(JSON.stringify(current, null, 2));
      const executed = fs.existsSync(outputPath)
        && fs.readFileSync(outputPath, 'utf8').trim() === 'COMPLEX_OK';
      if (executed) fs.rmSync(outputPath, { force: true });
      process.exit(current.status === 'done' && executed ? 0 : 1);
    }
  }
  throw new Error('复杂任务测试超时');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
