import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  doc,
  getDoc,
  serverTimestamp,
  setDoc
} from "firebase/firestore";
import {
  getDownloadURL,
  ref,
  uploadBytes
} from "firebase/storage";

import {
  createQuestionChunkStorage,
  restoreQuestionsFromChunks
} from "../../js/core/question-import.js";

export const EMULATOR_PROJECT_ID = "demo-dental-qa";
export const DEFAULT_FORMALIZATION_REPORT =
  process.env.DENTAL_ASSISTING_FORMALIZATION_REPORT ||
  "/Users/sakin/Library/Mobile Documents/com~apple~CloudDocs/歯科診療補助/教科書/" +
  "subject/runs/20260728-012040-national-exam-semantic-quality-final/" +
  "formalization_report.json";

function appRef(db, userId, name) {
  return doc(db, "users", userId, "app", name);
}

function runtimeQuestion(qid, question, image = null) {
  return {
    id: `legacy-${qid}`,
    subject: question.subject,
    subcategories: [...question.subcategories],
    question: question.question,
    answers: [...question.answers],
    explanation: question.explanation,
    orderedAnswers: question.orderedAnswers === true,
    imageUrl: image?.imageUrl || "",
    imagePath: image?.imagePath || "",
    imageName: question.imageFile || ""
  };
}

export async function createEmulatorUser({
  email,
  password,
  projectId = EMULATOR_PROJECT_ID
}) {
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    }
  );
  const body = await response.json();
  if (!response.ok || !body.localId) {
    throw new Error(`Auth Emulatorユーザー作成に失敗しました: ${JSON.stringify(body)}`);
  }
  return {
    projectId,
    email,
    password,
    userId: body.localId,
    idToken: body.idToken
  };
}

export async function seedOldFormal({
  testEnvironment,
  bundle,
  userId,
  stateFactory = qid => {
    const number = Number(qid.slice(1));
    if (number % 3 === 0) return 1;
    if (number % 3 === 1) return 2;
    return null;
  }
}) {
  const context = testEnvironment.authenticatedContext(userId);
  const db = context.firestore();
  const storage = context.storage();
  const imageAssets = {};
  const oldImageNames = [...new Set(
    [...bundle.oldByQid.values()].map(question => question.imageFile).filter(Boolean)
  )];
  for (const name of oldImageNames) {
    const imagePath = `users/${userId}/questions/legacy-assets/${name}`;
    const objectRef = ref(storage, imagePath);
    await uploadBytes(
      objectRef,
      new Uint8Array(await readFile(resolve(bundle.oldRun, "images", name))),
      { contentType: "image/jpeg" }
    );
    imageAssets[name] = {
      imageName: name,
      imagePath,
      imageUrl: await getDownloadURL(objectRef)
    };
  }
  const allQuestions = [...bundle.oldByQid].map(([qid, question]) =>
    runtimeQuestion(qid, question, imageAssets[question.imageFile])
  );
  const questionStatuses = {};
  for (const [qid] of bundle.oldByQid) {
    const state = stateFactory(qid);
    if (state === 1 || state === 2) questionStatuses[`legacy-${qid}`] = state;
  }
  const wrongQuestionIds = Object.entries(questionStatuses)
    .filter(([, state]) => state === 2)
    .map(([id]) => id);
  const questionStorage = createQuestionChunkStorage(allQuestions, {
    updatedAt: serverTimestamp()
  });
  await setDoc(appRef(db, userId, "questions"), questionStorage.manifest);
  for (const [index, chunk] of questionStorage.chunks.entries()) {
    await setDoc(
      appRef(db, userId, `questions-${String(index + 1).padStart(4, "0")}`),
      chunk
    );
  }
  await setDoc(appRef(db, userId, "progress"), {
    progress: {},
    questionStatuses,
    wrongQuestionIds,
    updatedAt: serverTimestamp()
  });
  await setDoc(appRef(db, userId, "settings"), {
    filteredQuestionIds: allQuestions.map(question => question.id),
    currentIndex: 0,
    deviceMode: "ipad",
    updatedAt: serverTimestamp()
  });
  await setDoc(appRef(db, userId, "pdfMaterials"), {
    pdfMaterials: [],
    updatedAt: serverTimestamp()
  });
  return { allQuestions, questionStatuses, imageAssets };
}

export async function readEmulatorState(testEnvironment, userId) {
  const context = testEnvironment.authenticatedContext(userId);
  const db = context.firestore();
  const questionsSnapshot = await getDoc(appRef(db, userId, "questions"));
  const manifest = questionsSnapshot.data();
  const chunks = [];
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const name = `questions-${String(index + 1).padStart(4, "0")}`;
    const snapshot = await getDoc(appRef(db, userId, name));
    chunks.push(snapshot.data());
  }
  const [progressSnapshot, syncSnapshot] = await Promise.all([
    getDoc(appRef(db, userId, "progress")),
    getDoc(appRef(db, userId, "sync"))
  ]);
  return {
    allQuestions: restoreQuestionsFromChunks(manifest, chunks),
    progress: progressSnapshot.data(),
    revision: syncSnapshot.data()?.revision
  };
}

export function runMigrationCli({
  userId,
  args,
  formalizationReport = DEFAULT_FORMALIZATION_REPORT,
  backupDirectory = resolve(".migration-backups/test")
}) {
  const output = execFileSync(process.execPath, [
    resolve("scripts/migrate_dental_assisting_345_to_350.mjs"),
    "--formalization-report",
    formalizationReport,
    "--user-id",
    userId,
    "--environment",
    "emulator",
    "--backup-dir",
    backupDirectory,
    ...args
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GCLOUD_PROJECT: EMULATOR_PROJECT_ID,
      FIRESTORE_EMULATOR_PORT: "8080",
      FIREBASE_STORAGE_EMULATOR_PORT: "9199"
    }
  });
  return JSON.parse(output);
}
