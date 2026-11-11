import { formatDisplayText, normalizeQuestionAnswers } from "./text-utils.js";
import { normalizeAnswerForComparison } from "./answer-comparison.js";
import { parseChoiceQuestion } from "./question-choices.js";

// 穴埋め問題の4択（改訂19）
// Fill-in-the-blank questions answered with four choices (revision 19).
//
// A question whose text has the blanks 【a】, 【b】, ... (one for each answer,
// in the order of the answers) is shown on the iPhone version with its blanks
// as boxes. Tapping a blank shows four choices: its answer and three wrong
// ones. The wrong choices are the question's own `distractors`
// ({ "a": ["…", "…", "…"] }, written with the question); when it has none or
// too few, they are picked from the answers of the subject's other questions.
// The words easily taken for the answer come first: its opposite (外発的 for
// 内発的, 下顎 for 上顎), words sharing most of it (顔面頭蓋 for 脳頭蓋) and
// neighbouring numbers; then the question's other blanks, its chapter and its
// subject. The picks depend only on the questions, so the confusing words are
// there every time; only their order is shuffled. The stored question is not
// changed, and choice questions (a. b. c. ... options) stay as they are.

export const BLANK_DISTRACTOR_COUNT = 3;
export const BLANK_DISTRACTOR_MAX_PER_BLANK = 10;
export const BLANK_DISTRACTOR_MAX_LENGTH = 200;

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const BLANK_PATTERN = /【([a-zａ-ｚ])】/gu;

// Pairs of words read as opposites, swapped wherever they appear in an answer.
const OPPOSITE_WORDS = [
  ["増加", "減少"], ["上昇", "低下"], ["亢進", "低下"], ["促進", "抑制"], ["興奮", "抑制"],
  ["陽性", "陰性"], ["急性", "慢性"], ["良性", "悪性"], ["先天", "後天"], ["原発", "続発"],
  ["能動", "受動"], ["随意", "不随意"], ["吸気", "呼気"], ["吸息", "呼息"], ["収縮", "弛緩"],
  ["拡張", "収縮"], ["酸性", "アルカリ性"], ["動脈", "静脈"], ["求心", "遠心"], ["近心", "遠心"],
  ["屈曲", "伸展"], ["内転", "外転"], ["内旋", "外旋"], ["開口", "閉口"], ["近位", "遠位"],
  ["浅層", "深層"], ["可逆", "不可逆"], ["顕性", "不顕性"], ["有髄", "無髄"], ["好子", "嫌子"],
  ["出現", "消失"], ["強化", "弱化"], ["肯定", "否定"], ["主観", "客観"], ["長期", "短期"],
  ["直接", "間接"], ["絶対", "相対"], ["優位", "劣位"], ["副交感", "交感"], ["乳歯", "永久歯"],
  ["上行", "下行"], ["同化", "異化"], ["合成", "分解"], ["酸化", "還元"], ["器質的", "機能的"],
  ["外発的", "内発的"], ["外向", "内向"], ["顕在", "潜在"], ["正常", "異常"],
  ["一次", "二次"], ["単純", "複雑"], ["頬側", "舌側"], ["唇側", "舌側"], ["歯冠", "歯根"],
  ["水平", "垂直"], ["横断", "縦断"], ["肥大", "萎縮"], ["過剰", "不足"], ["頻脈", "徐脈"],
  ["多尿", "乏尿"], ["好気", "嫌気"], ["男性", "女性"], ["高齢", "若年"], ["感覚", "運動"],
  ["生理的", "病的"], ["凸", "凹"],
  ["しない", "する"], ["できない", "できる"], ["されない", "される"], ["多い", "少ない"],
  ["高い", "低い"], ["大きい", "小さい"], ["長い", "短い"], ["広い", "狭い"], ["強い", "弱い"],
  ["早い", "遅い"], ["速い", "遅い"], ["浅い", "深い"], ["厚い", "薄い"], ["太い", "細い"],
  ["増える", "減る"], ["上がる", "下がる"], ["重い", "軽い"], ["押す", "引く"], ["吸う", "吐く"],
  ["開く", "閉じる"], ["伸ばす", "曲げる"], ["上げる", "下げる"]
];

// Characters read as opposites. Swapping one makes a word only when the
// subject uses it somewhere (下顎 for 上顎, but not 下皮 for 上皮).
const OPPOSITE_CHARACTERS = [
  "上下", "内外", "大小", "前後", "左右", "陽陰", "善悪", "高低", "長短", "多少", "有無", "浅深",
  "遠近", "増減", "強弱", "表裏", "吸呼", "入出", "開閉", "男女", "新旧", "主副", "硬軟", "厚薄",
  "濃淡", "太細", "急緩", "温冷", "乾湿", "明暗", "始終", "正負", "縦横", "軽重", "好嫌", "往復",
  "単複", "早晩", "⁺⁻"
];
const OPPOSITE_CHARACTER_MAP = new Map(
  OPPOSITE_CHARACTERS.flatMap(([first, second]) => [[first, second], [second, first]])
);
const NEGATIONS = ["非", "不", "無", "未"];
const KANJI_NUMBERS = "一二三四五六七八九十";

// ---- blanks ----

// "a", "ａ", "A" -> "a"; anything else -> "".
export function normalizeBlankLetter(value) {
  const letter = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  return /^[a-z]$/.test(letter) ? letter : "";
}

function findBlanks(text) {
  return [...text.matchAll(BLANK_PATTERN)].map(match => ({
    letter: normalizeBlankLetter(match[1]),
    start: match.index,
    end: match.index + match[0].length
  }));
}

// The letters of the blanks in a question text, in the order a, b, c.
export function blankLettersInText(text) {
  return [...new Set(findBlanks(formatDisplayText(text)).map(blank => blank.letter))].sort();
}

// The fill-in-the-blank question a stored question is shown as on the iPhone
// version, or null: { segments: [{ type: "text", text } | { type: "blank",
// letter }], blanks: [{ letter, index, answer }], ordered }.
export function parseBlankQuestion(question) {
  if (!question || parseChoiceQuestion(question)) return null;
  const text = formatDisplayText(question.question);
  const found = findBlanks(text);
  if (!found.length) return null;
  const answers = normalizeQuestionAnswers(question.answers);
  const letters = new Set(found.map(blank => blank.letter));
  // Every answer has its blank, and every blank its answer.
  if (letters.size !== answers.length) return null;
  if ([...letters].some(letter => LETTERS.indexOf(letter) >= answers.length)) return null;

  const segments = [];
  let cursor = 0;
  for (const blank of found) {
    if (blank.start > cursor) segments.push({ type: "text", text: text.slice(cursor, blank.start) });
    segments.push({ type: "blank", letter: blank.letter });
    cursor = blank.end;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });

  return {
    segments,
    blanks: answers.map((answer, index) => ({ letter: LETTERS[index], index, answer })),
    ordered: answers.length === 1 || question.orderedAnswers === true
  };
}

// The text of the question without its blanks.
function visibleText(parsed) {
  return parsed.segments
    .filter(segment => segment.type === "text")
    .map(segment => segment.text)
    .join("\n")
    .normalize("NFKC");
}

// The keys a wrong choice of the blank must not have: its answer and, when the
// answers may go in any order, the question's other answers.
function forbiddenKeys(parsed, blank) {
  const keys = new Set([normalizeAnswerForComparison(blank.answer)]);
  if (!parsed.ordered) parsed.blanks.forEach(other => keys.add(normalizeAnswerForComparison(other.answer)));
  return keys;
}

// A word as it is shown (Mg²⁺ stays Mg²⁺), and as it is compared.
function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function matchText(value) {
  return cleanText(value).normalize("NFKC");
}

// The question's own wrong choices for each blank ({ a: ["…"] }), without
// empty, repeated or correct ones.
export function readQuestionDistractors(question, parsed = parseBlankQuestion(question)) {
  const result = {};
  const source = question?.distractors;
  if (!parsed || !source || typeof source !== "object" || Array.isArray(source)) return result;
  for (const blank of parsed.blanks) {
    const list = source[blank.letter];
    if (!Array.isArray(list)) continue;
    const seen = forbiddenKeys(parsed, blank);
    const words = [];
    for (const item of list) {
      if (typeof item !== "string" && typeof item !== "number") continue;
      const text = cleanText(item);
      const key = normalizeAnswerForComparison(text);
      if (!text || seen.has(key)) continue;
      seen.add(key);
      words.push(text);
    }
    if (words.length) result[blank.letter] = words;
  }
  return result;
}

// ---- the words wrong choices are picked from ----

// The answers of the subject's questions (not of its choice questions, whose
// answers are option labels), and the subject's text, which tells real words
// from made-up ones.
export function createBlankChoicePool(questions, subject) {
  const words = [];
  const texts = [];
  for (const question of questions || []) {
    if (!question || question.subject !== subject) continue;
    texts.push(formatDisplayText(question.question), formatDisplayText(question.explanation || ""));
    if (parseChoiceQuestion(question)) continue;
    const chapter = Array.isArray(question.subcategories) ? String(question.subcategories[0] || "") : "";
    for (const answer of normalizeQuestionAnswers(question.answers)) {
      const text = cleanText(answer);
      if (!text) continue;
      words.push({ text, key: normalizeAnswerForComparison(text), chapter, questionId: question.id });
      texts.push(text);
    }
  }
  const corpus = texts.join("\n").normalize("NFKC");
  return { subject, words, wordKeys: new Set(words.map(word => word.key)), corpus };
}

function isKnownWord(pool, text) {
  if (!pool) return false;
  return pool.wordKeys.has(normalizeAnswerForComparison(text)) || pool.corpus.includes(matchText(text));
}

// ---- likeness ----

function characterKind(text) {
  // A number with a short unit (20本, 第2条, 1〜2), not a formula (Mg2+).
  const rest = text.replace(/[0-9]+(?:\.[0-9]+)?/g, "");
  if (/[0-9]/.test(text) && rest.length <= 3 && !/[A-Za-z]/.test(rest)) return "number";
  if (/^[ァ-ヶー・]+$/.test(text)) return "katakana";
  if (/^[ぁ-ゖー]+$/.test(text)) return "hiragana";
  if (/^[A-Za-z0-9 .+\-]+$/.test(text)) return "latin";
  return "mixed";
}

function commonPrefixLength(first, second) {
  let length = 0;
  while (length < first.length && length < second.length && first[length] === second[length]) length += 1;
  return length;
}

function commonSuffixLength(first, second) {
  let length = 0;
  while (
    length < first.length &&
    length < second.length &&
    first[first.length - 1 - length] === second[second.length - 1 - length]
  ) length += 1;
  return length;
}

function longestCommonSubstring(first, second) {
  let best = 0;
  let previous = new Array(second.length + 1).fill(0);
  for (let i = 1; i <= first.length; i += 1) {
    const current = new Array(second.length + 1).fill(0);
    for (let j = 1; j <= second.length; j += 1) {
      if (first[i - 1] === second[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

// "第#条" for 第2条, "#〜#" for 1〜2; null for a word without a number or a
// sentence.
function numberShape(text) {
  return /[0-9]/.test(text) && text.length <= 12 ? text.replace(/[0-9]+(?:\.[0-9]+)?/g, "#") : null;
}

// How much a word looks like the answer (higher is closer).
function likeness(candidate, answer) {
  const word = matchText(candidate);
  const target = matchText(answer);
  let score = 0;
  if (characterKind(word) === characterKind(target)) score += 2;
  const ratio = word.length / Math.max(1, target.length);
  if (ratio >= 0.6 && ratio <= 1.7) score += 1;
  else if (ratio > 3 || ratio < 1 / 3) score -= 3;
  score += Math.min(commonSuffixLength(word, target), 2);
  score += Math.min(commonPrefixLength(word, target), 2) * 0.5;
  return score;
}

// A word of about the answer's length that shares most of it (顔面頭蓋 for
// 脳頭蓋, 自己調整 for 自己認識), or a number written the same way (28本 for
// 32本, 2〜3 for 1〜2).
function isNearMiss(candidate, answer) {
  const word = matchText(candidate);
  const target = matchText(answer);
  const shapes = [numberShape(word), numberShape(target)];
  if (shapes[0] || shapes[1]) return shapes[0] !== null && shapes[0] === shapes[1];
  const ratio = word.length / Math.max(1, target.length);
  if (ratio < 0.5 || ratio > 2) return false;
  const common = longestCommonSubstring(word, target);
  return common >= 2 && common >= 0.4 * Math.min(word.length, target.length);
}

// A word inside the answer or holding it (乳児 or 乳児期の for 乳児期) is too
// close to be a wrong choice.
function overlapsAnswer(candidate, answer) {
  const word = matchText(candidate);
  const target = matchText(answer);
  return word.includes(target) || target.includes(word);
}

// ---- confusing words made from the answer ----

// Opposite words: [{ text, sure }]; a word that is not sure is used only when
// the subject has it.
export function oppositeWordCandidates(answer) {
  const text = cleanText(answer);
  const results = [];
  const add = (value, sure) => {
    if (value && value !== text) results.push({ text: value, sure });
  };

  // Whole words, the longest first, each place once (副交感 is not also 交感).
  const matches = [];
  for (const [first, second] of OPPOSITE_WORDS) {
    for (const [from, to] of [[first, second], [second, first]]) {
      let index = text.indexOf(from);
      while (index >= 0) {
        matches.push({ start: index, end: index + from.length, to });
        index = text.indexOf(from, index + 1);
      }
    }
  }
  matches.sort((first, second) => (second.end - second.start) - (first.end - first.start) || first.start - second.start);
  const taken = [];
  for (const match of matches) {
    if (taken.some(other => match.start < other.end && other.start < match.end)) continue;
    taken.push(match);
    add(text.slice(0, match.start) + match.to + text.slice(match.end), true);
  }

  // One character at a time.
  [...text].forEach((character, index, characters) => {
    const opposite = OPPOSITE_CHARACTER_MAP.get(character);
    if (!opposite) return;
    const swapped = [...characters];
    swapped[index] = opposite;
    add(swapped.join(""), character === "⁺" || character === "⁻");
  });

  // 非依存 for 依存 and back.
  if (NEGATIONS.includes(text[0]) && text.length > 2) add(text.slice(1), false);
  else if (text.length >= 2) NEGATIONS.forEach(prefix => add(prefix + text, false));

  // 第二 for 第一; 二 and 四 for 三 itself.
  [...text].forEach((character, index, characters) => {
    const value = KANJI_NUMBERS.indexOf(character);
    if (value < 0) return;
    for (const step of [1, -1]) {
      const next = KANJI_NUMBERS[value + step];
      if (!next) continue;
      const swapped = [...characters];
      swapped[index] = next;
      add(swapped.join(""), text.length === 1);
    }
  });

  const seen = new Set();
  return results.filter(result => {
    if (seen.has(result.text)) return false;
    seen.add(result.text);
    return true;
  });
}

// The answer with its numbers moved by one or two (2〜3 and 3〜4 for 1〜2, 第3条
// for 第2条). Not for decimals or sentences.
export function neighbouringNumbers(answer) {
  const text = cleanText(answer);
  if (!/[0-9]/.test(text) || text.length > 12 || /[0-9]\.[0-9]/.test(text)) return [];
  const results = [];
  for (const step of [1, -1, 2, -2]) {
    let usable = true;
    const moved = text.replace(/[0-9]+/g, digits => {
      const value = Number(digits) + step;
      if (value < 0 || (value === 0 && Number(digits) > 0)) usable = false;
      return String(value);
    });
    if (usable && moved !== text) results.push(moved);
  }
  return results;
}

// Choices the question itself gives: 再生する for 「【a】（再生する／再生しない）」.
function choicesInQuestion(parsed, answer) {
  const key = normalizeAnswerForComparison(answer);
  const text = parsed.segments.filter(segment => segment.type === "text").map(segment => segment.text).join("");
  const results = [];
  for (const match of text.matchAll(/[（(]([^（）()]{1,80})[）)]/gu)) {
    const parts = match[1].split(/[／/]/).map(cleanText).filter(Boolean);
    if (parts.length < 2 || !parts.some(part => normalizeAnswerForComparison(part) === key)) continue;
    results.push(...parts.filter(part => normalizeAnswerForComparison(part) !== key));
  }
  return results;
}

// ---- picking ----

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

// The wrong choices of a blank: the question's own first, then the confusing
// words, then words from the question, its chapter and its subject. The same
// questions give the same words.
export function pickBlankDistractors({ question, parsed = parseBlankQuestion(question), blankIndex, pool, count = BLANK_DISTRACTOR_COUNT }) {
  if (!parsed) return [];
  const blank = parsed.blanks[blankIndex];
  if (!blank) return [];
  const answer = cleanText(blank.answer);
  const seen = forbiddenKeys(parsed, blank);
  const shown = visibleText(parsed);
  const picked = [];
  const seed = `${question?.id || question?.question || ""}#${blank.letter}`;

  // Words made for the answer (its own wrong choices, its opposites,
  // neighbouring numbers) are taken as they are. Words from other questions
  // are not taken when they are printed in the question (they may be the
  // answer's other name: 「ライソゾーム（リソソームともいう）」) or are part of
  // the answer or hold it.
  const accept = (text, { made = false } = {}) => {
    const value = cleanText(text);
    const key = normalizeAnswerForComparison(value);
    if (!value || seen.has(key)) return false;
    if (!made) {
      const word = matchText(value);
      if (word.length >= 2 && shown.includes(word)) return false;
      if (overlapsAnswer(value, answer)) return false;
    }
    seen.add(key);
    picked.push(value);
    return true;
  };

  const chapter = Array.isArray(question?.subcategories) ? String(question.subcategories[0] || "") : "";
  const sameQuestion = parsed.ordered
    ? parsed.blanks.filter(other => other.index !== blank.index).map(other => cleanText(other.answer))
    : [];
  const poolWords = (pool?.words || []).filter(word => word.questionId !== question?.id);
  const chapterWords = new Set(poolWords.filter(word => word.chapter === chapter).map(word => word.text));
  const ranked = (words, bonus = () => 0) => [...new Set(words)]
    .map(text => ({ text, score: likeness(text, answer) + bonus(text), order: hashText(`${seed}\u0000${text}`) }))
    .sort((first, second) => second.score - first.score || first.order - second.order);
  const take = (words, { bonus, minimum = -Infinity, made = false, ordered = false } = {}) => {
    const list = ordered ? words.map(text => ({ text, score: 0 })) : ranked(words, bonus);
    for (const word of list) {
      if (picked.length >= count) return;
      if (word.score >= minimum) accept(word.text, { made });
    }
  };

  // 0. The question's own wrong choices as written, and the choices it gives.
  take(readQuestionDistractors(question, parsed)[blank.letter] || [], { made: true, ordered: true });
  take(choicesInQuestion(parsed, answer), { made: true, ordered: true });
  // 1. Opposite words.
  take(oppositeWordCandidates(answer)
    .filter(candidate => candidate.sure || isKnownWord(pool, candidate.text))
    .map(candidate => candidate.text), { made: true });
  // 2. Words sharing most of the answer, from the question, its chapter and its subject.
  const local = text => (sameQuestion.includes(text) ? 1.5 : 0) + (chapterWords.has(text) ? 1 : 0);
  take([...sameQuestion, ...poolWords.map(word => word.text)].filter(text => isNearMiss(text, answer)), { bonus: local });
  // 3. Neighbouring numbers.
  take(neighbouringNumbers(answer), { made: true, ordered: true });
  // 4. The question's other blanks, its chapter, its subject.
  take(sameQuestion, { minimum: -1 });
  take([...chapterWords], { minimum: 0 });
  take(poolWords.map(word => word.text), { minimum: 0 });
  // 5. Anything left from the subject.
  take([...sameQuestion, ...poolWords.map(word => word.text)]);
  return picked;
}

export function shuffleChoices(choices, random = Math.random) {
  const result = [...choices];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

// The four choices of a blank, its answer among them, in a shuffled order.
export function buildBlankChoices({ question, parsed = parseBlankQuestion(question), blankIndex, pool, random = Math.random }) {
  const blank = parsed?.blanks[blankIndex];
  if (!blank) return null;
  const distractors = pickBlankDistractors({ question, parsed, blankIndex, pool });
  return { answer: blank.answer, distractors, choices: shuffleChoices([blank.answer, ...distractors], random) };
}

// ---- writing them with a question ----

function blanksOf(question, answers, orderedAnswers) {
  return parseBlankQuestion({ question, answers, orderedAnswers: orderedAnswers === true });
}

// "a: 内発的, 価値観, 興味関心" lines for the question manager.
export function formatDistractorsText(distractors) {
  if (!distractors || typeof distractors !== "object" || Array.isArray(distractors)) return "";
  return Object.keys(distractors)
    .map(normalizeBlankLetter)
    .filter(Boolean)
    .sort()
    .map(letter => `${letter}: ${(distractors[letter] || []).map(cleanText).filter(Boolean).join(", ")}`)
    .join("\n");
}

// The question manager's "a: 誤答, 誤答, 誤答" lines: { distractors, error }.
// Nothing written gives null (the question has no wrong choices of its own).
export function parseDistractorsText(text, { question, answers, orderedAnswers } = {}) {
  const lines = String(text ?? "").split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { distractors: null, error: "" };
  const parsed = blanksOf(question, answers, orderedAnswers);
  if (!parsed) {
    return {
      distractors: null,
      error: "間違いの選択肢は、問題文に【a】【b】…の空欄があり、空欄の数と答えの数が同じ問題だけに書けます。"
    };
  }
  const distractors = {};
  for (const [index, line] of lines.entries()) {
    const match = /^([a-zａ-ｚA-ZＡ-Ｚ])\s*[:：]\s*(.*)$/u.exec(line);
    if (!match) {
      return { distractors: null, error: `間違いの選択肢の${index + 1}行目は「a: 誤答1, 誤答2, 誤答3」の形で書いてください。` };
    }
    const letter = normalizeBlankLetter(match[1]);
    const blank = parsed.blanks.find(item => item.letter === letter);
    if (!blank) {
      return { distractors: null, error: `間違いの選択肢の「${letter}」に当たる空欄【${letter}】が問題文にありません。` };
    }
    if (distractors[letter]) {
      return { distractors: null, error: `間違いの選択肢に「${letter}」の行が2つあります。1行にまとめてください。` };
    }
    const words = match[2].split(/[,，、]/).map(cleanText).filter(Boolean);
    if (!words.length) continue;
    if (words.length > BLANK_DISTRACTOR_MAX_PER_BLANK) {
      return { distractors: null, error: `間違いの選択肢の「${letter}」は${BLANK_DISTRACTOR_MAX_PER_BLANK}個までにしてください。` };
    }
    const long = words.find(word => word.length > BLANK_DISTRACTOR_MAX_LENGTH);
    if (long) {
      return { distractors: null, error: `間違いの選択肢の「${letter}」の「${long.slice(0, 20)}…」は${BLANK_DISTRACTOR_MAX_LENGTH}文字以内にしてください。` };
    }
    const forbidden = forbiddenKeys(parsed, blank);
    const correct = words.find(word => forbidden.has(normalizeAnswerForComparison(word)));
    if (correct) {
      return { distractors: null, error: `間違いの選択肢の「${letter}」に正解と同じ「${correct}」があります。` };
    }
    distractors[letter] = [...new Set(words)];
  }
  return { distractors: Object.keys(distractors).length ? distractors : null, error: "" };
}

// The `distractors` of a question in a JSON file: { distractors, issues,
// warnings }. Issues stop the import; warnings tell what is not used.
export function normalizeImportedDistractors(raw, { question, answers, orderedAnswers, rowNo } = {}) {
  const issues = [];
  const warnings = [];
  const row = rowNo ? `行${rowNo}: ` : "";
  if (raw === undefined || raw === null) return { distractors: null, issues, warnings };

  let source = raw;
  // [["…"], ["…"]] is read as a, b, ... (Firestore keeps no arrays in arrays).
  if (Array.isArray(source) && source.every(item => Array.isArray(item))) {
    source = Object.fromEntries(source.map((item, index) => [LETTERS[index], item]));
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    issues.push(`${row}distractors は {"a": ["誤答1", "誤答2", "誤答3"]} の形で書いてください。`);
    return { distractors: null, issues, warnings };
  }

  const parsed = blanksOf(question, answers, orderedAnswers);
  if (!parsed) {
    warnings.push(`${row}distractors は、問題文に【a】【b】…の空欄があり、空欄の数と answers の数が同じ問題だけで使われるため、登録しません。`);
    return { distractors: null, issues, warnings };
  }

  const distractors = {};
  for (const [key, value] of Object.entries(source)) {
    const letter = normalizeBlankLetter(key);
    if (!letter) {
      issues.push(`${row}distractors の「${key}」は空欄の記号（a、b、c…）ではありません。`);
      continue;
    }
    const blank = parsed.blanks.find(item => item.letter === letter);
    if (!blank) {
      warnings.push(`${row}distractors の「${letter}」に当たる空欄【${letter}】が問題文にないため、使いません。`);
      continue;
    }
    if (!Array.isArray(value)) {
      issues.push(`${row}distractors の「${letter}」は ["誤答1", "誤答2", "誤答3"] のように配列で書いてください。`);
      continue;
    }
    if (value.length > BLANK_DISTRACTOR_MAX_PER_BLANK) {
      issues.push(`${row}distractors の「${letter}」は${BLANK_DISTRACTOR_MAX_PER_BLANK}個までにしてください。`);
      continue;
    }
    if (value.some(item => typeof item !== "string" && typeof item !== "number")) {
      issues.push(`${row}distractors の「${letter}」には文字列だけを書いてください。`);
      continue;
    }
    const forbidden = forbiddenKeys(parsed, blank);
    const words = [];
    const seen = new Set();
    for (const item of value) {
      const text = cleanText(item);
      const keyText = normalizeAnswerForComparison(text);
      if (!text || seen.has(keyText)) continue;
      if (text.length > BLANK_DISTRACTOR_MAX_LENGTH) {
        issues.push(`${row}distractors の「${letter}」の「${text.slice(0, 20)}…」は${BLANK_DISTRACTOR_MAX_LENGTH}文字以内にしてください。`);
        continue;
      }
      if (forbidden.has(keyText)) {
        warnings.push(`${row}distractors の「${letter}」の「${text}」は正解と同じため、使いません。`);
        continue;
      }
      seen.add(keyText);
      words.push(text);
    }
    if (!words.length) continue;
    if (words.length !== BLANK_DISTRACTOR_COUNT) {
      warnings.push(words.length > BLANK_DISTRACTOR_COUNT
        ? `${row}distractors の「${letter}」は${words.length}個あります。4択には最初の${BLANK_DISTRACTOR_COUNT}個を使います。`
        : `${row}distractors の「${letter}」は${words.length}個です。足りない分は自動で選びます。`);
    }
    distractors[letter] = words;
  }
  const missing = parsed.blanks.filter(blank => !distractors[blank.letter]).map(blank => blank.letter);
  if (Object.keys(distractors).length && missing.length) {
    warnings.push(`${row}空欄【${missing.join("】【")}】の distractors がないため、自動で選びます。`);
  }
  return { distractors: Object.keys(distractors).length ? distractors : null, issues, warnings };
}
