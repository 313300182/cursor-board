function buildQuestionResponse(input) {
  if (!Array.isArray(input.answers) || input.answers.length === 0) {
    throw new Error('至少需要回答一个问题');
  }
  return {
    outcome: {
      outcome: 'answered',
      answers: input.answers.map((answer) => ({
        questionId: answer.questionId,
        selectedOptionIds: answer.selectedOptionIds || [],
      })),
    },
  };
}

function buildPlanResponse(input) {
  if (input.accepted) {
    return { outcome: { outcome: 'accepted' } };
  }
  return {
    outcome: {
      outcome: 'rejected',
      reason: input.reason || '用户拒绝该计划',
    },
  };
}

module.exports = {
  buildQuestionResponse,
  buildPlanResponse,
};
