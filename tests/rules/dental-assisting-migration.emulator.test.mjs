import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { resolve } from "node:path";

import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
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
import {
  loadMigrationBundle
} from "../../scripts/lib/dental-assisting-migration-core.mjs";

const PROJECT_ID = "demo-dental-qa";
const FORMALIZATION_REPORT = process.env.DENTAL_ASSISTING_FORMALIZATION_REPORT ||
  "/Users/sakin/Library/Mobile Documents/com~apple~CloudDocs/歯科診療補助/教科書/" +
  "subject/runs/20260728-012040-national-exam-semantic-quality-final/" +
  "formalization_report.json";
const SCRIPT = resolve("scripts/migrate_dental_assisting_345_to_350.mjs");
const BACKUP_DIR = resolve(".migration-backups/test");
let testEnvironment;
let bundle;

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

async function seedOldFormal(userId, stateFactory) {
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
    currentIndex: 344,
    updatedAt: serverTimestamp()
  });
  await setDoc(appRef(db, userId, "pdfMaterials"), {
    pdfMaterials: [],
    updatedAt: serverTimestamp()
  });
  return { allQuestions, questionStatuses, imageAssets };
}

async function readState(userId) {
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
  const progressSnapshot = await getDoc(appRef(db, userId, "progress"));
  return {
    allQuestions: restoreQuestionsFromChunks(manifest, chunks),
    progress: progressSnapshot.data()
  };
}

function runCli(userId, ...args) {
  const output = execFileSync(process.execPath, [
    SCRIPT,
    "--formalization-report",
    FORMALIZATION_REPORT,
    "--user-id",
    userId,
    "--environment",
    "emulator",
    "--backup-dir",
    BACKUP_DIR,
    ...args
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GCLOUD_PROJECT: PROJECT_ID,
      FIRESTORE_EMULATOR_PORT: "8080",
      FIREBASE_STORAGE_EMULATOR_PORT: "9199"
    }
  });
  return JSON.parse(output);
}

before(async () => {
  testEnvironment = await initializeTestEnvironment({ projectId: PROJECT_ID });
  bundle = await loadMigrationBundle(FORMALIZATION_REPORT);
});

after(async () => {
  await testEnvironment?.cleanup();
});

test("Emulatorで345→350、複数ユーザー状態、冪等性、ロールバックを検証する", async () => {
  const users = ["migration-alice", "migration-bob"];
  const sourceSnapshots = {};
  for (const userId of users) {
    sourceSnapshots[userId] = await seedOldFormal(userId, qid => {
      const number = Number(qid.slice(1));
      if (userId.endsWith("alice")) {
        if (number % 3 === 0) return 1;
        if (number % 3 === 1) return 2;
        return null;
      }
      if (number % 4 === 0) return 2;
      if (number % 2 === 0) return 1;
      return null;
    });
    const dryRun = runCli(userId, "--dry-run");
    assert.equal(dryRun.result, "pass");
    assert.equal(dryRun.writesPerformed, 0);
    assert.equal(dryRun.target.questionCount, 350);
    const applied = runCli(userId, "--apply");
    assert.equal(applied.result, "pass");
    assert.equal(applied.verification.targetQuestionCount, 350);
    assert.equal(applied.verification.orphanStatusCount, 0);
    const migrated = await readState(userId);
    assert.equal(
      migrated.allQuestions.filter(question => question.subject === "歯科診療補助").length,
      350
    );
    assert.equal(
      migrated.allQuestions.filter(question => question.imageName).length,
      21
    );
    assert.equal(
      new Set(migrated.allQuestions.filter(question => question.imageName)
        .map(question => question.imageName)).size,
      17
    );
    const rerun = runCli(userId, "--apply");
    assert.equal(rerun.alreadyCompleted, true);
    assert.equal(rerun.writesPerformed, 0);
    const rollback = runCli(userId, "--rollback", applied.backupId);
    assert.equal(rollback.result, "pass");
    assert.equal(rollback.finalQuestionCount, 345);
    const restored = await readState(userId);
    assert.equal(
      restored.allQuestions.filter(question => question.subject === "歯科診療補助").length,
      345
    );
    assert.deepEqual(
      restored.progress.questionStatuses,
      sourceSnapshots[userId].questionStatuses
    );
    const secondRollback = runCli(userId, "--rollback", applied.backupId);
    assert.equal(secondRollback.alreadyRolledBack, true);
    assert.equal(secondRollback.writesPerformed, 0);
  }
});

test("Emulatorで画像準備後の失敗から同じmigrationIdで再開できる", async () => {
  const userId = "migration-resume";
  await seedOldFormal(userId, qid => Number(qid.slice(1)) % 5 === 0 ? 2 : null);
  const failed = spawnSync(process.execPath, [
    SCRIPT,
    "--formalization-report",
    FORMALIZATION_REPORT,
    "--user-id",
    userId,
    "--environment",
    "emulator",
    "--backup-dir",
    BACKUP_DIR,
    "--apply",
    "--simulate-failure-after",
    "images"
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      GCLOUD_PROJECT: PROJECT_ID,
      FIRESTORE_EMULATOR_PORT: "8080",
      FIREBASE_STORAGE_EMULATOR_PORT: "9199"
    }
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /failure simulation/);
  const resumed = runCli(userId, "--apply");
  assert.equal(resumed.result, "pass");
  assert.equal(resumed.verification.targetQuestionCount, 350);
  const migrated = await readState(userId);
  assert.equal(
    migrated.allQuestions.filter(question => question.subject === "歯科診療補助").length,
    350
  );
});
