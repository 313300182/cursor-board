const assert = require('node:assert/strict');
const test = require('node:test');

const { buildQuestionResponse, buildPlanResponse } = require('../interactions');

test('问答回复转换为 Cursor ACP answered 格式', () => {
  const response = buildQuestionResponse({
    answers: [
      { questionId: 'q1', selectedOptionIds: ['vue'] },
      { questionId: 'q2', selectedOptionIds: ['typescript', 'vitest'] },
    ],
  });

  assert.deepEqual(response, {
    outcome: {
      outcome: 'answered',
      answers: [
        { questionId: 'q1', selectedOptionIds: ['vue'] },
        { questionId: 'q2', selectedOptionIds: ['typescript', 'vitest'] },
      ],
    },
  });
});

test('计划接受与拒绝转换为 Cursor ACP 格式', () => {
  assert.deepEqual(buildPlanResponse({ accepted: true }), {
    outcome: { outcome: 'accepted' },
  });
  assert.deepEqual(buildPlanResponse({ accepted: false, reason: '需要补充测试方案' }), {
    outcome: { outcome: 'rejected', reason: '需要补充测试方案' },
  });
});
