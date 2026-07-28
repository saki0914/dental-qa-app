function normalizeLegacyJapaneseToken(value) {
  return value
    .replace(/[ァ-ヶ]/g, character =>
      String.fromCharCode(character.charCodeAt(0) - 0x60)
    )
    .replace(/ー/g, "");
}

export function normalizeAnswerForComparison(value) {
  return normalizeLegacyJapaneseToken(
    String(value ?? "")
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "")
      .replaceAll("～", "〜")
      .replaceAll("~", "〜")
  );
}

export function isOrderSensitiveQuestion(question) {
  return question?.orderedAnswers === true;
}

export function compareAnswerLists(expectedValues, actualValues, options = {}) {
  const expected = (Array.isArray(expectedValues) ? expectedValues : [expectedValues])
    .map(normalizeAnswerForComparison);
  const actual = (Array.isArray(actualValues) ? actualValues : [actualValues])
    .map(normalizeAnswerForComparison);

  if (expected.length !== actual.length) return false;

  if (options.ordered === true) {
    return expected.every((value, index) => value === actual[index]);
  }

  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  return expectedSorted.every((value, index) => value === actualSorted[index]);
}

export function diffAnswerLists(expectedValues, actualValues) {
  const expected = (Array.isArray(expectedValues) ? expectedValues : [expectedValues])
    .map(normalizeAnswerForComparison);
  const actual = (Array.isArray(actualValues) ? actualValues : [actualValues])
    .map(normalizeAnswerForComparison);
  const remaining = [...actual];
  const missing = [];

  expected.forEach(value => {
    const index = remaining.indexOf(value);
    if (index === -1) {
      missing.push(value);
    } else {
      remaining.splice(index, 1);
    }
  });

  return { missing, extra: remaining };
}
