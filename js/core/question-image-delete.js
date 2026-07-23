export function isQuestionImagePathForUser(path, userId) {
  if (typeof path !== "string" || !path || path !== path.trim()) return false;
  if (typeof userId !== "string" || !userId) return false;
  const prefix = `users/${userId}/questions/`;
  return path.startsWith(prefix) && path.length > prefix.length;
}

function isStorageObjectNotFound(error) {
  return error?.code === "storage/object-not-found";
}

export async function deleteQuestionImageFiles(targets, options) {
  const questions = Array.isArray(targets) ? targets : [];
  const { userId, deleteByPath } = options || {};

  return Promise.all(questions.map(async question => {
    const imagePath = question?.imagePath;
    if (!imagePath) {
      return { question, status: "no-image" };
    }

    if (!isQuestionImagePathForUser(imagePath, userId)) {
      return {
        question,
        status: "failed",
        reason: "invalid-path"
      };
    }

    if (typeof deleteByPath !== "function") {
      return {
        question,
        status: "failed",
        reason: "storage-unavailable"
      };
    }

    try {
      await deleteByPath(imagePath);
      return { question, status: "deleted" };
    } catch (error) {
      if (isStorageObjectNotFound(error)) {
        return { question, status: "already-missing" };
      }

      return {
        question,
        status: "failed",
        reason: "delete-failed",
        error
      };
    }
  }));
}

export function restoreFailedQuestionDeletes(currentQuestions, originalQuestions, failedQuestionIds) {
  const current = Array.isArray(currentQuestions) ? currentQuestions : [];
  const original = Array.isArray(originalQuestions) ? originalQuestions : [];
  const failedIds = failedQuestionIds instanceof Set
    ? failedQuestionIds
    : new Set(failedQuestionIds || []);
  const currentById = new Map(current.map(question => [question.id, question]));
  const originalIds = new Set(original.map(question => question.id));
  const restored = [];

  original.forEach(question => {
    if (currentById.has(question.id)) {
      restored.push(currentById.get(question.id));
    } else if (failedIds.has(question.id)) {
      restored.push(question);
    }
  });

  current.forEach(question => {
    if (!originalIds.has(question.id)) restored.push(question);
  });

  return restored;
}
