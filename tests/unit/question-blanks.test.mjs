import assert from "node:assert/strict";
import test from "node:test";
import {
  blankLettersInText,
  buildBlankChoices,
  createBlankChoicePool,
  formatDistractorsText,
  neighbouringNumbers,
  normalizeBlankLetter,
  normalizeImportedDistractors,
  oppositeWordCandidates,
  parseBlankQuestion,
  parseDistractorsText,
  pickBlankDistractors,
  readQuestionDistractors,
  shuffleChoices
} from "../../js/core/question-blanks.js";

// 穴埋め問題の4択（改訂19）
// Fill-in-the-blank questions answered with four choices (revision 19).

const MOTIVATION = {
  id: "q-motivation",
  subject: "心理学",
  subcategories: ["03_動機づけ"],
  question: "動機づけの2種類について空欄を埋めよ。\n【a】動機づけ：外部からの刺激や【b】によって行動が動機づけられること\n【c】動機づけ：自分の【d】や【e】などによって行動が動機づけられること",
  answers: ["外発的", "報酬", "内発的", "興味", "関心"],
  orderedAnswers: true
};

function subject(questions) {
  return questions.map((question, index) => ({ id: `q${index}`, subject: "解剖学", subcategories: ["1章"], ...question }));
}

test("問題文の【a】【b】…を空欄として読み、答えを記号の順に対応させる", () => {
  const parsed = parseBlankQuestion(MOTIVATION);
  assert.deepEqual(parsed.blanks.map(blank => [blank.letter, blank.answer]), [
    ["a", "外発的"], ["b", "報酬"], ["c", "内発的"], ["d", "興味"], ["e", "関心"]
  ]);
  assert.equal(parsed.ordered, true);
  assert.deepEqual(parsed.segments.slice(0, 3), [
    { type: "text", text: "動機づけの2種類について空欄を埋めよ。\n" },
    { type: "blank", letter: "a" },
    { type: "text", text: "動機づけ：外部からの刺激や" }
  ]);
  assert.deepEqual(blankLettersInText(MOTIVATION.question), ["a", "b", "c", "d", "e"]);
  assert.equal(normalizeBlankLetter("ａ"), "a");
  assert.equal(normalizeBlankLetter("刺激"), "");

  // One blank: its answer, ordered or not.
  const single = parseBlankQuestion({ question: "三胚葉のうち、エナメル質をつくるのは【a】胚葉である。", answers: ["外"] });
  assert.equal(single.ordered, true);
  assert.deepEqual(single.segments, [
    { type: "text", text: "三胚葉のうち、エナメル質をつくるのは" },
    { type: "blank", letter: "a" },
    { type: "text", text: "胚葉である。" }
  ]);

  // 【刺激】 and other headings are not blanks; full-width letters are.
  const headings = parseBlankQuestion({
    question: "【刺激】電車が怖い→【行動】乗る→【結果】【ａ】\n【その後】【ｂ】",
    answers: ["パニック", "乗らない"],
    orderedAnswers: true
  });
  assert.deepEqual(headings.blanks.map(blank => blank.letter), ["a", "b"]);
  assert.equal(headings.segments.filter(segment => segment.type === "blank").length, 2);

  // The same blank twice is one blank.
  const twice = parseBlankQuestion({ question: "【a】と【b】、そして再び【a】", answers: ["甲", "乙"], orderedAnswers: true });
  assert.equal(twice.blanks.length, 2);
  assert.equal(twice.segments.filter(segment => segment.type === "blank").length, 3);
});

test("空欄と答えの数が合わない問題、選択問題、空欄のない問題は穴埋めにしない", () => {
  assert.equal(parseBlankQuestion({ question: "【a】と【b】", answers: ["甲"] }), null);
  assert.equal(parseBlankQuestion({ question: "【a】と【c】", answers: ["甲", "乙"] }), null);
  assert.equal(parseBlankQuestion({ question: "【a】", answers: ["甲", "乙"] }), null);
  assert.equal(parseBlankQuestion({ question: "下垂体前葉の発生母地は？", answers: ["ラトケ嚢"] }), null);
  assert.equal(parseBlankQuestion({
    question: "【a】に当てはまるのはどれか。\na. 甲\nb. 乙\nc. 丙\nd. 丁",
    answers: ["c"]
  }), null);
  assert.equal(parseBlankQuestion(null), null);
});

test("問題に書かれた間違いの選択肢を、正解・重複・空を除いて読む", () => {
  const question = {
    question: "【a】や【b】を促す",
    answers: ["動機づけ", "行動変容"],
    orderedAnswers: true,
    distractors: { a: ["情報提供", " 情報提供 ", "", "動機づけ", "行動変容", 3], b: "意識改革", c: ["余分"] }
  };
  assert.deepEqual(readQuestionDistractors(question), { a: ["情報提供", "行動変容", "3"] });
  // Answers that may go in any order are not wrong choices of the other blanks.
  assert.deepEqual(readQuestionDistractors({ ...question, orderedAnswers: false }), { a: ["情報提供", "3"] });
  assert.deepEqual(readQuestionDistractors({ ...question, distractors: [["情報提供"]] }), {});
});

test("反対の言葉を作る: 単語の組は確かなもの、1文字の入れ替えは教科にある言葉だけ", () => {
  const texts = candidates => candidates.map(candidate => `${candidate.text}${candidate.sure ? "" : "?"}`);
  assert.ok(texts(oppositeWordCandidates("外発的")).includes("内発的"));
  assert.ok(texts(oppositeWordCandidates("上顎")).includes("下顎?"));
  // The longest word first: 副交感 is not also read as 交感.
  assert.deepEqual(texts(oppositeWordCandidates("副交感神経")).filter(text => !text.endsWith("?")), ["交感神経"]);
  assert.ok(texts(oppositeWordCandidates("交感神経")).includes("副交感神経"));
  assert.ok(texts(oppositeWordCandidates("Cl⁻")).includes("Cl⁺"));
  assert.ok(texts(oppositeWordCandidates("Mg²⁺")).includes("Mg²⁻"), "上付き文字のまま");
  assert.ok(texts(oppositeWordCandidates("再生しない")).includes("再生する"));
  assert.ok(texts(oppositeWordCandidates("非依存")).includes("依存?"));
  assert.ok(texts(oppositeWordCandidates("三")).includes("二") && texts(oppositeWordCandidates("三")).includes("四"));
  assert.ok(texts(oppositeWordCandidates("第一鰓弓")).includes("第二鰓弓?"));
  assert.deepEqual(oppositeWordCandidates("ミトコンドリア").filter(candidate => candidate.sure), []);
});

test("数の答えには、同じ書き方の隣の数を作る", () => {
  assert.deepEqual(neighbouringNumbers("2"), ["3", "1", "4"]);
  assert.deepEqual(neighbouringNumbers("20本"), ["21本", "19本", "22本", "18本"]);
  assert.deepEqual(neighbouringNumbers("1〜2"), ["2〜3", "3〜4"]);
  assert.deepEqual(neighbouringNumbers("第2条"), ["第3条", "第1条", "第4条"]);
  assert.deepEqual(neighbouringNumbers("1.5kg"), []);
  assert.deepEqual(neighbouringNumbers("ミトコンドリア"), []);
  assert.deepEqual(neighbouringNumbers("3つの段階を経て成長することがわかっている"), []);
});

test("自動の誤答は、反対の言葉など紛らわしい言葉を先に、同じ問題・同じ章・同じ教科の答えから選ぶ", () => {
  const questions = subject([
    MOTIVATION,
    { question: "【a】は自分の価値観から生まれる。", answers: ["価値観"], subcategories: ["03_動機づけ"] },
    { question: "【a】は外的な報酬がなくても続く。", answers: ["自己決定感"], subcategories: ["03_動機づけ"] },
    { question: "知覚の【a】ができる。", answers: ["構え"], subcategories: ["01_知覚"] }
  ].map(question => ({ ...question, subject: "心理学" })));
  const motivation = questions[0];
  const pool = createBlankChoicePool(questions, "心理学");
  const parsed = parseBlankQuestion(motivation);

  const first = pickBlankDistractors({ question: motivation, parsed, blankIndex: 0, pool });
  assert.equal(first.length, 3);
  assert.equal(first[0], "内発的", "反対の言葉は毎回いちばん先");
  assert.ok(!first.includes("外発的"));
  // Every time: the same questions give the same words, whatever their order.
  const reversed = createBlankChoicePool([...questions].reverse(), "心理学");
  assert.deepEqual(pickBlankDistractors({ question: motivation, parsed, blankIndex: 0, pool: reversed }), first);
  assert.deepEqual(pickBlankDistractors({ question: motivation, parsed, blankIndex: 0, pool }), first);

  // Choice questions add no answers (their answers are labels).
  const withChoice = createBlankChoicePool([
    ...questions,
    { id: "choice", subject: "心理学", question: "どれか。\na. 甲\nb. 乙", answers: ["b"] }
  ], "心理学");
  assert.equal(withChoice.words.some(word => word.text === "b"), false);
  // Other subjects are not used.
  const otherSubject = createBlankChoicePool([...questions, { id: "x", subject: "化学", question: "【a】", answers: ["酵素"] }], "心理学");
  assert.equal(otherSubject.words.some(word => word.text === "酵素"), false);
});

test("1文字の入れ替えで作った言葉は、教科の問題・解説にあるときだけ使う", () => {
  const base = { question: "口腔の粘膜は【a】でおおわれる。", answers: ["上皮"] };
  const questions = subject([base, { question: "【a】組織", answers: ["結合"] }, { question: "【a】の神経", answers: ["上顎"] }]);
  const pool = createBlankChoicePool(questions, "解剖学");
  const picked = pickBlankDistractors({ question: questions[0], blankIndex: 0, pool });
  assert.ok(!picked.includes("下皮"), "教科にない言葉は作らない");

  const jaw = pickBlankDistractors({ question: questions[2], blankIndex: 0, pool });
  assert.ok(!jaw.includes("下顎"), "下顎は教科にない");
  const withLower = subject([...questions.map(({ id, ...question }) => question), { question: "【a】は動く。", answers: ["顎関節"], explanation: "下顎が動く。" }]);
  const lowerPool = createBlankChoicePool(withLower, "解剖学");
  assert.equal(pickBlankDistractors({ question: withLower[2], blankIndex: 0, pool: lowerPool })[0], "下顎");
});

test("問題文に書かれた言葉、答えの一部や答えを含む言葉、順不同の他の答えは誤答にしない", () => {
  const questions = subject([
    { question: "【a】（リソソームともいう）は不要物を分解する。", answers: ["ライソゾーム"] },
    { question: "【a】は細胞内の消化を担う。", answers: ["リソソーム"] },
    { question: "【a】は分泌に働く。", answers: ["ゴルジ装置"] },
    { question: "【a】はATPをつくる。", answers: ["ミトコンドリア"] },
    { question: "【a】は脂質を代謝する。", answers: ["ライソゾーム膜"] },
    { question: "【a】期の次は幼児期。", answers: ["乳児"] },
    { question: "【a】は翻訳の場。", answers: ["リボソーム"] }
  ]);
  const pool = createBlankChoicePool(questions, "解剖学");
  const picked = pickBlankDistractors({ question: questions[0], blankIndex: 0, pool });
  assert.ok(!picked.includes("リソソーム"), "問題文の別名");
  assert.ok(!picked.includes("ライソゾーム膜"), "答えを含む言葉");
  assert.equal(picked.length, 3);

  const unordered = subject([
    { question: "唾液の抗菌因子は【a】と【b】である。", answers: ["リゾチーム", "ラクトフェリン"] },
    { question: "【a】", answers: ["スタテリン"] },
    { question: "【a】", answers: ["アミラーゼ"] },
    { question: "【a】", answers: ["ムチン"] }
  ]);
  const unorderedPool = createBlankChoicePool(unordered, "解剖学");
  const unorderedPicked = pickBlankDistractors({ question: unordered[0], blankIndex: 0, pool: unorderedPool });
  assert.ok(!unorderedPicked.includes("ラクトフェリン"), "順不同なら、もう1つの答えも正解なので出さない");
  assert.equal(unorderedPicked.length, 3);
});

test("問題文の（A／B）の選択肢と、数の隣の数を誤答にする", () => {
  const questions = subject([
    { question: "エナメル質は一度作り終えると【a】（再生する／再生しない）。", answers: ["再生しない"] },
    { question: "塗布後【a】分待つ。", answers: ["1〜2"] },
    { question: "【a】", answers: ["象牙質"] }
  ]);
  const pool = createBlankChoicePool(questions, "解剖学");
  assert.equal(pickBlankDistractors({ question: questions[0], blankIndex: 0, pool })[0], "再生する");
  assert.deepEqual(pickBlankDistractors({ question: questions[1], blankIndex: 0, pool }).slice(0, 2), ["2〜3", "3〜4"]);
});

test("問題に書かれた誤答を先に使い、足りない分を自動で選ぶ", () => {
  const questions = subject([
    {
      question: "【a】胚葉からエナメル質ができる。",
      answers: ["外"],
      distractors: { a: ["中", "内胚"] }
    },
    { question: "【a】", answers: ["内"] },
    { question: "【a】", answers: ["神経堤"] }
  ]);
  const pool = createBlankChoicePool(questions, "解剖学");
  const picked = pickBlankDistractors({ question: questions[0], blankIndex: 0, pool });
  assert.deepEqual(picked.slice(0, 2), ["中", "内胚"]);
  assert.equal(picked[2], "内", "残りは反対の言葉");

  const full = { ...questions[0], distractors: { a: ["中", "内胚", "神経", "余分"] } };
  assert.deepEqual(pickBlankDistractors({ question: full, blankIndex: 0, pool }), ["中", "内胚", "神経"]);
  // Too few words in the subject: fewer choices, never the answer twice.
  const lonely = subject([{ question: "【a】と【b】", answers: ["甲", "乙"], orderedAnswers: true }]);
  assert.deepEqual(pickBlankDistractors({ question: lonely[0], blankIndex: 0, pool: createBlankChoicePool(lonely, "解剖学") }), ["乙"]);
});

test("4択は答えを1つだけ含み、並びだけを混ぜる", () => {
  const questions = subject([MOTIVATION].map(question => ({ ...question, subject: "解剖学" })));
  const pool = createBlankChoicePool(questions, "解剖学");
  const built = buildBlankChoices({ question: questions[0], blankIndex: 2, pool, random: () => 0 });
  assert.equal(built.answer, "内発的");
  assert.equal(built.choices.length, 4);
  assert.equal(built.choices.filter(choice => choice === "内発的").length, 1);
  assert.deepEqual([...built.choices].sort(), [built.answer, ...built.distractors].sort());
  assert.equal(built.distractors[0], "外発的");
  assert.deepEqual(shuffleChoices([1, 2, 3, 4], () => 0.999), [1, 2, 3, 4]);
  assert.deepEqual(shuffleChoices([1, 2, 3, 4], () => 0), [2, 3, 4, 1]);
  assert.equal(buildBlankChoices({ question: questions[0], blankIndex: 9, pool }), null);
});

test("問題管理の「a: 誤答, 誤答, 誤答」を読み書きする", () => {
  const form = { question: "【a】や【b】を促す", answers: ["動機づけ", "行動変容"], orderedAnswers: true };
  const read = parseDistractorsText("a: 情報提供, 意識づけ、自己管理\nＢ：意識改革，生活改善, 習慣化\n", form);
  assert.equal(read.error, "");
  assert.deepEqual(read.distractors, { a: ["情報提供", "意識づけ", "自己管理"], b: ["意識改革", "生活改善", "習慣化"] });
  assert.equal(formatDistractorsText(read.distractors), "a: 情報提供, 意識づけ, 自己管理\nb: 意識改革, 生活改善, 習慣化");
  assert.deepEqual(parseDistractorsText(formatDistractorsText(read.distractors), form), read);

  assert.deepEqual(parseDistractorsText("  \n", form), { distractors: null, error: "" });
  assert.match(parseDistractorsText("情報提供, 意識づけ", form).error, /1行目は「a: 誤答1, 誤答2, 誤答3」/);
  assert.match(parseDistractorsText("c: 甲", form).error, /空欄【c】が問題文にありません/);
  assert.match(parseDistractorsText("a: 甲\na: 乙", form).error, /「a」の行が2つ/);
  assert.match(parseDistractorsText("a: 動機づけ, 甲", form).error, /正解と同じ「動機づけ」/);
  assert.match(parseDistractorsText("a: 甲", { question: "答えは？", answers: ["甲"] }).error, /空欄があり/);
  assert.equal(formatDistractorsText(null), "");
});

test("問題JSONの distractors を確かめる（形の誤りは登録を止め、使わないものは知らせる）", () => {
  const item = { question: "【a】や【b】を促す", answers: ["動機づけ", "行動変容"], orderedAnswers: true, rowNo: 3 };
  assert.deepEqual(normalizeImportedDistractors(undefined, item), { distractors: null, issues: [], warnings: [] });

  const ok = normalizeImportedDistractors({ a: ["情報提供", "意識づけ", "自己管理"], b: ["意識改革", "生活改善", "習慣化"] }, item);
  assert.deepEqual(ok, {
    distractors: { a: ["情報提供", "意識づけ", "自己管理"], b: ["意識改革", "生活改善", "習慣化"] },
    issues: [],
    warnings: []
  });
  // [[…], […]] is read as a, b (Firestore keeps no arrays inside arrays).
  assert.deepEqual(normalizeImportedDistractors([["情報提供", "意識づけ", "自己管理"]], item).distractors, { a: ["情報提供", "意識づけ", "自己管理"] });

  const mixed = normalizeImportedDistractors({ a: ["動機づけ", "情報提供"], c: ["甲"] }, item);
  assert.deepEqual(mixed.distractors, { a: ["情報提供"] });
  assert.deepEqual(mixed.issues, []);
  assert.deepEqual(mixed.warnings, [
    "行3: distractors の「a」の「動機づけ」は正解と同じため、使いません。",
    "行3: distractors の「a」は1個です。足りない分は自動で選びます。",
    "行3: distractors の「c」に当たる空欄【c】が問題文にないため、使いません。",
    "行3: 空欄【b】の distractors がないため、自動で選びます。"
  ]);

  assert.deepEqual(normalizeImportedDistractors("情報提供", item).issues, [
    "行3: distractors は {\"a\": [\"誤答1\", \"誤答2\", \"誤答3\"]} の形で書いてください。"
  ]);
  assert.deepEqual(normalizeImportedDistractors({ a: "情報提供" }, item).issues, [
    "行3: distractors の「a」は [\"誤答1\", \"誤答2\", \"誤答3\"] のように配列で書いてください。"
  ]);
  assert.deepEqual(normalizeImportedDistractors({ "1": ["甲"] }, item).issues, [
    "行3: distractors の「1」は空欄の記号（a、b、c…）ではありません。"
  ]);
  assert.deepEqual(normalizeImportedDistractors({ a: [{ text: "甲" }] }, item).issues, [
    "行3: distractors の「a」には文字列だけを書いてください。"
  ]);
  assert.equal(normalizeImportedDistractors({ a: Array.from({ length: 11 }, (_, index) => `誤${index}`) }, item).issues.length, 1);
  assert.match(normalizeImportedDistractors({ a: ["甲".repeat(201)] }, item).issues[0], /200文字以内/);
  assert.deepEqual(normalizeImportedDistractors({ a: ["甲", "乙", "丙", "丁"], b: ["戊", "己", "庚"] }, item).warnings, [
    "行3: distractors の「a」は4個あります。4択には最初の3個を使います。"
  ]);

  const notBlank = normalizeImportedDistractors({ a: ["甲"] }, { question: "答えは？", answers: ["乙"], rowNo: 1 });
  assert.equal(notBlank.distractors, null);
  assert.match(notBlank.warnings[0], /空欄があり、空欄の数と answers の数が同じ問題だけで使われるため、登録しません/);
});
