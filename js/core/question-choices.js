import { formatDisplayText, normalizeQuestionAnswers } from "./text-utils.js";

// 選択問題（改訂14）
// Choice questions (revision 14).
//
// A question is a choice question when the last lines of its text are options
// labeled a, b, c, ... in order, one per line ("a. 第一鰓弓 — 顔面神経"; at
// least two), and every answer is the label of a different option ("c", or
// "a" and "d" for two answers). The study screen then shows the text before
// the options as the question and the options as buttons. The stored question
// is not changed: the question manager and older versions of the app keep
// showing the whole text, and other questions stay written answers.

const LABELS = "abcdefghijklmnopqrstuvwxyz";

// "a. text" with a half- or full-width lowercase letter and period.
const OPTION_LINE = /^\s*([a-zａ-ｚ])\s*[.．]\s*(.*?)\s*$/u;

function readOptionLine(line) {
  const match = OPTION_LINE.exec(line);
  if (!match || !match[2]) return null;
  return { label: match[1].normalize("NFKC"), text: match[2] };
}

function splitLines(text) {
  return formatDisplayText(text).split(/\r\n|\r|\n/);
}

// "c", "Ｃ", "c." -> "c"; anything else -> "".
export function normalizeChoiceLabel(value) {
  const label = String(value ?? "").normalize("NFKC").trim().toLowerCase().replace(/\.$/, "");
  return /^[a-z]$/.test(label) ? label : "";
}

// { stem, choices: [{ label, text }] } when the text ends with options a, b, ...
export function splitChoiceText(text) {
  const lines = splitLines(text);
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end -= 1;

  const run = [];
  let start = end;
  while (start > 0) {
    const option = readOptionLine(lines[start - 1]);
    if (!option) break;
    run.unshift(option);
    start -= 1;
  }

  // Lines of the question just before the options may look like options too;
  // the options begin at the last "a".
  const first = run.map(option => option.label).lastIndexOf("a");
  if (first < 0) return null;
  const choices = run.slice(first);
  if (choices.length < 2 || choices.some((option, index) => option.label !== LABELS[index])) return null;

  const stem = lines.slice(0, start + first).join("\n").trimEnd();
  return { stem, choices };
}

// The choice question a stored question is shown as, or null for a written answer.
export function parseChoiceQuestion(question) {
  if (!question) return null;
  const split = splitChoiceText(question.question);
  if (!split) return null;

  const labels = split.choices.map(option => option.label);
  const answers = normalizeQuestionAnswers(question.answers).map(normalizeChoiceLabel);
  if (!answers.length || answers.length > labels.length) return null;
  if (answers.some(answer => !labels.includes(answer))) return null;
  if (new Set(answers).size !== answers.length) return null;

  return {
    stem: split.stem,
    choices: split.choices,
    answers,
    ordered: question.orderedAnswers === true && answers.length > 1,
    multiple: answers.length > 1
  };
}

export function isCorrectChoiceSelection(choiceQuestion, selectedLabels) {
  const picked = (selectedLabels || []).map(normalizeChoiceLabel);
  const { answers } = choiceQuestion;
  if (picked.length !== answers.length) return false;
  if (choiceQuestion.ordered) return picked.every((label, index) => label === answers[index]);
  const pickedSet = new Set(picked);
  return pickedSet.size === picked.length && answers.every(answer => pickedSet.has(answer));
}

// "2つ選べ" for two answers, "" for one.
export function choiceRequirementText(choiceQuestion) {
  if (!choiceQuestion?.multiple) return "";
  const count = choiceQuestion.answers.length;
  return choiceQuestion.ordered ? `${count}つを順に選べ` : `${count}つ選べ`;
}

// Why a question that looks meant as a choice question is shown as a written
// answer ("" when it is a choice question or does not look like one).
export function choiceQuestionFormatProblem(question) {
  if (!question || parseChoiceQuestion(question)) return "";
  const answers = normalizeQuestionAnswers(question.answers);
  const labelAnswers = answers.map(normalizeChoiceLabel);
  const answersAreLabels = answers.length > 0 && labelAnswers.every(Boolean);
  const split = splitChoiceText(question.question);

  if (split) {
    const labels = split.choices.map(option => option.label);
    if (!answersAreLabels) {
      return "問題文の最後に選択肢（a. 〜）がありますが、answers が選択肢の記号ではないため記述式で出題されます。選択問題にするには answers を記号（例: \"c\"）にしてください。";
    }
    const missing = labelAnswers.filter(label => !labels.includes(label));
    if (missing.length) {
      return `answers の「${missing.join("、")}」が選択肢にないため記述式で出題されます。`;
    }
    return "answers に同じ記号が重複しているため記述式で出題されます。";
  }

  const optionLines = splitLines(question.question).filter(line => readOptionLine(line)).length;
  if (answersAreLabels && optionLines >= 2) {
    return "選択肢（a. 〜）が問題文の最後に a から順に1行ずつ並んでいないため、記述式で出題されます。";
  }
  return "";
}
