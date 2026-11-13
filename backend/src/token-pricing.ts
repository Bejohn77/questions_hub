export const tokenRates = {
  MCQ: 1,
  CQ: 10,
  SHORT: 5,
} as const;

function isPricedQuestionType(type: string): type is keyof typeof tokenRates {
  return Object.prototype.hasOwnProperty.call(tokenRates, type);
}

export function calculateTokenCost(questions: readonly { type: string }[]): number {
  return questions.reduce((total, question) => {
    if (!isPricedQuestionType(question.type)) {
      throw new Error(`No token rate is configured for question type ${question.type}`);
    }
    return total + tokenRates[question.type];
  }, 0);
}
