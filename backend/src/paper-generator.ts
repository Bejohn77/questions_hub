import { randomInt } from "node:crypto";

export type MarkedQuestion = { id: string; marks: number };
type ExactQuestionSelection =
  | { exact: true; lower: number; higher: number; questions: MarkedQuestion[] }
  | { exact: false; lower: number | null; higher: number | null };

export function selectExactQuestions(
  questions: MarkedQuestion[],
  targetMarks: number,
  maxQuestionCount = 500,
): ExactQuestionSelection {
  const searchLimit = Math.min(101_000, targetMarks + 1_000);
  const previousSum = new Int32Array(searchLimit + 1).fill(-1);
  const previousQuestion = new Int32Array(searchLimit + 1).fill(-1);
  const questionCount = new Uint16Array(searchLimit + 1);
  previousSum[0] = -2;
  let highestReachable = 0;

  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    const marks = questions[questionIndex].marks;
    if (!Number.isInteger(marks) || marks <= 0) continue;
    const currentLimit = Math.min(searchLimit, highestReachable + marks);
    for (let sum = currentLimit; sum >= marks; sum -= 1) {
      const priorSum = sum - marks;
      if (previousSum[sum] !== -1 || previousSum[priorSum] === -1 || questionCount[priorSum] >= maxQuestionCount) continue;
      previousSum[sum] = priorSum;
      previousQuestion[sum] = questionIndex;
      questionCount[sum] = questionCount[priorSum] + 1;
      highestReachable = Math.max(highestReachable, sum);
    }
  }

  let lower = targetMarks;
  while (lower > 0 && previousSum[lower] === -1) lower -= 1;
  let higher = targetMarks + 1;
  while (higher <= searchLimit && previousSum[higher] === -1) higher += 1;

  if (previousSum[targetMarks] === -1) {
    return {
      exact: false,
      lower: lower === 0 ? null : lower,
      higher: higher > searchLimit ? null : higher,
    };
  }

  const selected: MarkedQuestion[] = [];
  for (let sum = targetMarks; sum > 0;) {
    const questionIndex = previousQuestion[sum];
    if (questionIndex < 0) throw new Error("Unable to reconstruct exact question selection");
    selected.push(questions[questionIndex]);
    sum = previousSum[sum];
  }
  return { exact: true, lower: targetMarks, higher: targetMarks, questions: selected.reverse() };
}

export function selectRandomQuestions<T>(questions: T[], count: number): T[] {
  const shuffled = [...questions];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, count);
}

export type CqSetConfiguration = {
  setNumber: number;
  chapters: string[];
  questionCount: number;
};

export function selectCqQuestionsBySet<T extends { id: string; chapter: string }>(
  candidates: T[],
  sets: CqSetConfiguration[],
  assignments?: { questionId: string; setNumber: number }[],
): { questions: T[]; assignments: { questionId: string; setNumber: number }[] } |
  { error: { setNumber: number; availableCount: number; requestedCount: number } } {
  const selectedIds = new Set<string>();
  const selectedQuestions: T[] = [];
  const selectedAssignments: { questionId: string; setNumber: number }[] = [];

  if (assignments) {
    for (const set of sets) {
      const eligible = candidates.filter((question) => set.chapters.includes(question.chapter));
      const assigned = assignments
        .filter((assignment) => assignment.setNumber === set.setNumber)
        .map((assignment) => eligible.find((question) => question.id === assignment.questionId));
      if (
        assigned.length !== set.questionCount ||
        new Set(assigned.flatMap((question) => question ? [question.id] : [])).size !== assigned.length ||
        assigned.some((question) => question === undefined || selectedIds.has(question.id))
      ) {
        return {
          error: {
            setNumber: set.setNumber,
            availableCount: eligible.length,
            requestedCount: set.questionCount,
          },
        };
      }
      for (const question of assigned) {
        if (!question) continue;
        selectedIds.add(question.id);
        selectedQuestions.push(question);
        selectedAssignments.push({ questionId: question.id, setNumber: set.setNumber });
      }
    }

    if (
      assignments.length !== selectedAssignments.length ||
      assignments.some((assignment) => !selectedAssignments.some((selected) =>
        selected.questionId === assignment.questionId && selected.setNumber === assignment.setNumber))
    ) {
      return {
        error: {
          setNumber: sets[0]?.setNumber ?? 1,
          availableCount: candidates.length,
          requestedCount: assignments.length,
        },
      };
    }
    return { questions: selectedQuestions, assignments: selectedAssignments };
  }

  const slots = sets.flatMap((set) => Array.from({ length: set.questionCount }, () => set));
  const questionsBySlot: (T | undefined)[] = Array.from({ length: slots.length });
  const shuffledCandidates = selectRandomQuestions(candidates, candidates.length);

  function assignQuestion(question: T, visitedSlots: Set<number>): boolean {
    for (const [slotIndex, set] of slots.entries()) {
      if (visitedSlots.has(slotIndex) || !set.chapters.includes(question.chapter)) continue;
      visitedSlots.add(slotIndex);
      const currentQuestion = questionsBySlot[slotIndex];
      if (!currentQuestion || assignQuestion(currentQuestion, visitedSlots)) {
        questionsBySlot[slotIndex] = question;
        return true;
      }
    }
    return false;
  }

  for (const question of shuffledCandidates) {
    if (questionsBySlot.every((item) => item !== undefined)) break;
    assignQuestion(question, new Set<number>());
  }

  for (const set of sets) {
    const setQuestions = slots.flatMap((slot, index) => {
      const question = questionsBySlot[index];
      return slot.setNumber === set.setNumber && question ? [question] : [];
    });
    if (setQuestions.length < set.questionCount) {
      return {
        error: {
          setNumber: set.setNumber,
          availableCount: setQuestions.length,
          requestedCount: set.questionCount,
        },
      };
    }
    for (const question of setQuestions) {
      if (!question) continue;
      selectedIds.add(question.id);
      selectedQuestions.push(question);
      selectedAssignments.push({ questionId: question.id, setNumber: set.setNumber });
    }
  }

  return { questions: selectedQuestions, assignments: selectedAssignments };
}
