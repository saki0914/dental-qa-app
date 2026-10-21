import assert from "node:assert/strict";
import test from "node:test";
import {
  choiceQuestionFormatProblem,
  choiceRequirementText,
  isCorrectChoiceSelection,
  normalizeChoiceLabel,
  parseChoiceQuestion,
  splitChoiceText
} from "../../js/core/question-choices.js";

const SINGLE = {
  question: "鰓弓と神経支配の組み合わせで正しいのはどれか。\na. 第一鰓弓 — 顔面神経\nb. 第二鰓弓 — 舌咽神経\nc. 第三鰓弓 — 舌咽神経\nd. 第一鰓弓 — 舌咽神経",
  answers: ["c"]
};

const DOUBLE = {
  question: "唾液中の抗菌因子はどれか。2つ選べ。\na. リゾチーム\nb. スタテリン\nc. ラクトフェリン\nd. 重炭酸塩",
  answers: ["a", "c"]
};

test("問題文の最後のa.〜d.の行を選択肢、その前を問題文として読み、記号の答えを持つ", () => {
  const single = parseChoiceQuestion(SINGLE);
  assert.equal(single.stem, "鰓弓と神経支配の組み合わせで正しいのはどれか。");
  assert.deepEqual(single.choices, [
    { label: "a", text: "第一鰓弓 — 顔面神経" },
    { label: "b", text: "第二鰓弓 — 舌咽神経" },
    { label: "c", text: "第三鰓弓 — 舌咽神経" },
    { label: "d", text: "第一鰓弓 — 舌咽神経" }
  ]);
  assert.deepEqual(single.answers, ["c"]);
  assert.equal(single.multiple, false);
  assert.equal(single.ordered, false);
  assert.equal(choiceRequirementText(single), "");

  const double = parseChoiceQuestion(DOUBLE);
  assert.equal(double.stem, "唾液中の抗菌因子はどれか。2つ選べ。");
  assert.deepEqual(double.answers, ["a", "c"]);
  assert.equal(double.multiple, true);
  assert.equal(choiceRequirementText(double), "2つ選べ");
});

test("全角の記号・ピリオド、CRLF、末尾の空行、\\n表記を受け付け、選択肢の文字は変えない", () => {
  const parsed = parseChoiceQuestion({
    question: "象牙質の有機質の主成分はどれか。\r\nａ．Ⅰ型コラーゲン\r\nｂ．Ⅱ型コラーゲン\r\nｃ．アメロゲニン\r\n\r\n",
    answers: ["Ａ"]
  });
  assert.deepEqual(parsed.choices.map(option => option.label), ["a", "b", "c"]);
  assert.equal(parsed.choices[0].text, "Ⅰ型コラーゲン", "選択肢の文字はNFKCで変えない");
  assert.deepEqual(parsed.answers, ["a"]);

  const escaped = splitChoiceText("正しいのはどれか。\\na. 解糖系\\nb. 電子伝達系");
  assert.equal(escaped.stem, "正しいのはどれか。");
  assert.equal(escaped.choices.length, 2);
  assert.deepEqual(parseChoiceQuestion({ question: "どれか。\na. 甲\nb. 乙", answers: "b" }).answers, ["b"], "answersが文字列でも読む");
});

test("選択肢はaから順に始まる最後の並び。問題文の側にあるa.風の行は問題文に含める", () => {
  const parsed = splitChoiceText("次の記述について答えよ。\nb. の記述は誤りである。\na. 正しい\nb. 誤り");
  assert.equal(parsed.stem, "次の記述について答えよ。\nb. の記述は誤りである。");
  assert.deepEqual(parsed.choices.map(option => option.label), ["a", "b"]);
});

test("選択問題にしないもの: 穴埋め、記号でない答え、選択肢にない記号、重複、選択肢の後の文、記号の抜け、1つだけの選択肢", () => {
  assert.equal(parseChoiceQuestion({
    question: "下垂体の発生について答えよ。\n前葉：口腔の上皮である【a】から発生する\n後葉：間脳の【b】から発生する",
    answers: ["ラトケ嚢", "漏斗"],
    orderedAnswers: true
  }), null);
  assert.equal(parseChoiceQuestion({
    question: "図のA〜Cの名称を答えよ。\nA：【a】\nB：【b】\nC：【c】",
    answers: ["a", "b", "c"]
  }), null, "大文字・全角コロンの穴埋め欄は選択肢ではない");
  assert.equal(parseChoiceQuestion({ ...SINGLE, answers: ["第三鰓弓 — 舌咽神経"] }), null);
  assert.equal(parseChoiceQuestion({ ...SINGLE, answers: ["e"] }), null);
  assert.equal(parseChoiceQuestion({ ...DOUBLE, answers: ["a", "a"] }), null);
  assert.equal(parseChoiceQuestion({ ...SINGLE, answers: [] }), null);
  assert.equal(parseChoiceQuestion({ question: `${SINGLE.question}\n（2018年）`, answers: ["c"] }), null);
  assert.equal(parseChoiceQuestion({ question: "どれか。\na. 甲\nb. 乙\nd. 丁", answers: ["a"] }), null);
  assert.equal(parseChoiceQuestion({ question: "どれか。\na. 甲", answers: ["a"] }), null);
  assert.equal(parseChoiceQuestion({ question: "どれか。\na. \nb. 乙", answers: ["b"] }), null, "空の選択肢");
  assert.equal(parseChoiceQuestion(null), null);
});

test("選んだ記号の判定: 順不同は集合、orderedAnswersは選んだ順、数の違い・重複は不正解", () => {
  const double = parseChoiceQuestion(DOUBLE);
  assert.equal(isCorrectChoiceSelection(double, ["c", "a"]), true);
  assert.equal(isCorrectChoiceSelection(double, ["A", "Ｃ"]), true);
  assert.equal(isCorrectChoiceSelection(double, ["a"]), false);
  assert.equal(isCorrectChoiceSelection(double, ["a", "a"]), false);
  assert.equal(isCorrectChoiceSelection(double, ["a", "b"]), false);
  assert.equal(isCorrectChoiceSelection(double, ["a", "c", "d"]), false);

  const ordered = parseChoiceQuestion({ ...DOUBLE, answers: ["c", "a"], orderedAnswers: true });
  assert.equal(ordered.ordered, true);
  assert.equal(choiceRequirementText(ordered), "2つを順に選べ");
  assert.equal(isCorrectChoiceSelection(ordered, ["c", "a"]), true);
  assert.equal(isCorrectChoiceSelection(ordered, ["a", "c"]), false);

  const single = parseChoiceQuestion({ ...SINGLE, orderedAnswers: true });
  assert.equal(single.ordered, false, "答えが1つなら順序はない");
  assert.equal(isCorrectChoiceSelection(single, ["c"]), true);
  assert.equal(isCorrectChoiceSelection(single, ["b"]), false);
});

test("記号の正規化", () => {
  assert.equal(normalizeChoiceLabel("Ｃ"), "c");
  assert.equal(normalizeChoiceLabel(" c. "), "c");
  assert.equal(normalizeChoiceLabel("cc"), "");
  assert.equal(normalizeChoiceLabel("1"), "");
  assert.equal(normalizeChoiceLabel(undefined), "");
});

test("取込みの注意: 選択問題のつもりで形が崩れたものだけ理由を返し、記号を答える図の問題などには出さない", () => {
  assert.equal(choiceQuestionFormatProblem(SINGLE), "");
  assert.match(choiceQuestionFormatProblem({ ...SINGLE, answers: ["第三鰓弓 — 舌咽神経"] }), /answers が選択肢の記号ではない/);
  assert.match(choiceQuestionFormatProblem({ ...SINGLE, answers: ["e"] }), /「e」が選択肢にない/);
  assert.match(choiceQuestionFormatProblem({ ...DOUBLE, answers: ["a", "a"] }), /重複/);
  assert.match(
    choiceQuestionFormatProblem({ question: `${SINGLE.question}\n（2018年）`, answers: ["c"] }),
    /a から順に1行ずつ並んでいない/
  );
  assert.equal(choiceQuestionFormatProblem({
    question: "上顎の位置図で、下中央に入る教材上の記号は何か。",
    answers: ["c"]
  }), "", "選択肢の行がない記号の答えは記述式のまま注意しない");
  assert.equal(choiceQuestionFormatProblem({
    question: "下垂体の発生について答えよ。\n前葉：【a】\n後葉：【b】",
    answers: ["ラトケ嚢", "漏斗"]
  }), "");
});
