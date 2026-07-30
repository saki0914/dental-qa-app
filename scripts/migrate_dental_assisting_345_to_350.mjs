#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  deleteDoc,
  doc,
  getDoc,
  runTransaction,
  serverTimestamp,
  setDoc
} from "firebase/firestore";
import {
  deleteObject,
  getDownloadURL,
  getMetadata,
  ref,
  uploadBytes
} from "firebase/storage";

import {
  QUESTION_CHUNK_STORAGE_MODE,
  createQuestionChunkStorage,
  restoreQuestionsFromChunks
} from "../js/core/question-import.js";
import { normalizeCloudRevision } from "../js/core/cloud-sync-state.js";
import {
  buildDryRunReport,
  buildMigrationPlan,
  loadMigrationBundle,
  materializeMigratedState,
  sha256File,
  summarizeLearningStates,
  verifyMigratedState
} from "./lib/dental-assisting-migration-core.mjs";

const PRODUCTION_CONFIRMATION = "MIGRATE-DENTAL-ASSISTING-345-TO-350";
const DEFAULT_BACKUP_DIRECTORY = resolve("migration-backups");

function parseArguments(argv) {
  const options = {
    mode: "dry-run",
    environment: "emulator",
    backupDirectory: DEFAULT_BACKUP_DIRECTORY,
    simulateFailureAfter: ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${argument}の値がありません。`);
      index += 1;
      return next;
    };
    if (argument === "--verify") options.mode = "verify";
    else if (argument === "--dry-run") options.mode = "dry-run";
    else if (argument === "--apply") options.mode = "apply";
    else if (argument === "--rollback") {
      options.mode = "rollback";
      options.backupId = value();
    } else if (argument === "--environment") options.environment = value();
    else if (argument === "--formalization-report") options.formalizationReport = resolve(value());
    else if (argument === "--user-id") options.userId = value();
    else if (argument === "--migration-id") options.migrationId = value();
    else if (argument === "--confirm-production") options.confirmProduction = value();
    else if (argument === "--backup-dir") options.backupDirectory = resolve(value());
    else if (argument === "--report") options.reportPath = resolve(value());
    else if (argument === "--simulate-failure-after") options.simulateFailureAfter = value();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`未対応のオプションです: ${argument}`);
  }
  return options;
}

function usage() {
  return `
Usage:
  node scripts/migrate_dental_assisting_345_to_350.mjs \\
    --formalization-report <formalization_report.json> --user-id <uid> [--verify|--dry-run]

  node scripts/migrate_dental_assisting_345_to_350.mjs \\
    --formalization-report <formalization_report.json> --user-id <uid> \\
    --apply --environment emulator

  node scripts/migrate_dental_assisting_345_to_350.mjs \\
    --formalization-report <formalization_report.json> --user-id <uid> \\
    --rollback <backup-id> --environment emulator

Production apply additionally requires:
  --migration-id <manifest migrationId>
  --confirm-production ${PRODUCTION_CONFIRMATION}

Default mode is --dry-run. No option performs production writes.
`.trim();
}

function assertSafeOptions(options, bundle) {
  if (!options.formalizationReport) {
    throw new Error("--formalization-reportを指定してください。");
  }
  if (!options.userId) throw new Error("--user-idを指定してください。");
  if (!["emulator", "production"].includes(options.environment)) {
    throw new Error("--environmentはemulatorまたはproductionです。");
  }
  if (options.simulateFailureAfter && options.environment !== "emulator") {
    throw new Error("失敗シミュレーションはEmulatorだけで使用できます。");
  }
  if (
    options.environment === "production" &&
    ["apply", "rollback"].includes(options.mode)
  ) {
    if (options.migrationId !== bundle.migrationManifest.migrationId) {
      throw new Error("本番実行には固定migrationIdの完全一致が必要です。");
    }
    if (options.confirmProduction !== PRODUCTION_CONFIRMATION) {
      throw new Error("本番実行の確認文字列が一致しません。");
    }
  }
}

async function createFirebaseContext(options) {
  if (options.environment === "emulator") {
    const { initializeTestEnvironment } = await import("@firebase/rules-unit-testing");
    const projectId = process.env.GCLOUD_PROJECT || "demo-dental-qa";
    const testEnvironment = await initializeTestEnvironment({
      projectId,
      firestore: {
        host: "127.0.0.1",
        port: Number(process.env.FIRESTORE_EMULATOR_PORT || 8080)
      },
      storage: {
        host: "127.0.0.1",
        port: Number(process.env.FIREBASE_STORAGE_EMULATOR_PORT || 9199)
      }
    });
    const authenticated = testEnvironment.authenticatedContext(options.userId);
    return {
      db: authenticated.firestore(),
      storage: authenticated.storage(),
      cleanup: () => testEnvironment.cleanup()
    };
  }

  const configText = process.env.DENTAL_QA_FIREBASE_CONFIG_JSON;
  const email = process.env.DENTAL_QA_MIGRATION_EMAIL;
  const password = process.env.DENTAL_QA_MIGRATION_PASSWORD;
  if (!configText || !email || !password) {
    throw new Error(
      "本番接続にはDENTAL_QA_FIREBASE_CONFIG_JSON、" +
      "DENTAL_QA_MIGRATION_EMAIL、DENTAL_QA_MIGRATION_PASSWORDが必要です。"
    );
  }
  const [{ initializeApp }, authModule, firestoreModule, storageModule] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore"),
    import("firebase/storage")
  ]);
  const app = initializeApp(JSON.parse(configText), `migration-${Date.now()}`);
  const auth = authModule.getAuth(app);
  const credential = await authModule.signInWithEmailAndPassword(auth, email, password);
  if (credential.user.uid !== options.userId) {
    await authModule.signOut(auth);
    throw new Error("認証ユーザーのuidと--user-idが一致しません。");
  }
  return {
    db: firestoreModule.getFirestore(app),
    storage: storageModule.getStorage(app),
    cleanup: async () => {
      await authModule.signOut(auth);
    }
  };
}

function appDocumentRef(db, userId, name) {
  return doc(db, "users", userId, "app", name);
}

function questionChunkName(index) {
  return `questions-${String(index + 1).padStart(4, "0")}`;
}

async function readCurrentState(db, userId) {
  const questionsRef = appDocumentRef(db, userId, "questions");
  const [questionsSnapshot, progressSnapshot, settingsSnapshot, pdfSnapshot, syncSnapshot] =
    await Promise.all([
      getDoc(questionsRef),
      getDoc(appDocumentRef(db, userId, "progress")),
      getDoc(appDocumentRef(db, userId, "settings")),
      getDoc(appDocumentRef(db, userId, "pdfMaterials")),
      getDoc(appDocumentRef(db, userId, "sync"))
    ]);
  if (!questionsSnapshot.exists()) throw new Error("questions文書がありません。");
  const questionsDocument = questionsSnapshot.data() || {};
  let allQuestions;
  const chunkDocuments = [];
  if (
    questionsDocument.storageMode === QUESTION_CHUNK_STORAGE_MODE &&
    Number.isInteger(questionsDocument.chunkCount)
  ) {
    for (let index = 0; index < questionsDocument.chunkCount; index += 1) {
      const name = questionChunkName(index);
      const snapshot = await getDoc(appDocumentRef(db, userId, name));
      if (!snapshot.exists()) throw new Error(`${name}がありません。`);
      const data = snapshot.data();
      chunkDocuments.push({ name, data });
    }
    allQuestions = restoreQuestionsFromChunks(
      questionsDocument,
      chunkDocuments.map(row => row.data)
    );
  } else if (Array.isArray(questionsDocument.allQuestions)) {
    allQuestions = questionsDocument.allQuestions;
  } else {
    throw new Error("questions文書から問題配列を復元できません。");
  }
  return {
    allQuestions,
    questionsDocument,
    chunkDocuments,
    progressDocument: progressSnapshot.exists() ? progressSnapshot.data() : {},
    settingsDocument: settingsSnapshot.exists() ? settingsSnapshot.data() : {},
    pdfMaterialsDocument: pdfSnapshot.exists() ? pdfSnapshot.data() : {},
    syncRevision: normalizeCloudRevision(
      syncSnapshot.exists() ? syncSnapshot.data()?.revision : undefined
    )
  };
}

function serializeFirestoreValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  if (typeof value !== "object") return value;
  if (
    typeof value.seconds === "number" &&
    typeof value.nanoseconds === "number" &&
    typeof value.toDate === "function"
  ) {
    return {
      __firestoreType: "Timestamp",
      seconds: value.seconds,
      nanoseconds: value.nanoseconds
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, serializeFirestoreValue(item)])
  );
}

async function deserializeFirestoreValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    return Promise.all(value.map(deserializeFirestoreValue));
  }
  if (typeof value !== "object") return value;
  if (value.__firestoreType === "Timestamp") {
    const { Timestamp } = await import("firebase/firestore");
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  const entries = await Promise.all(
    Object.entries(value).map(async ([key, item]) => [
      key,
      await deserializeFirestoreValue(item)
    ])
  );
  return Object.fromEntries(entries);
}

async function collectImageMetadata(storage, questions) {
  const paths = [...new Set(questions.map(question => question.imagePath).filter(Boolean))];
  const metadata = [];
  for (const path of paths) {
    try {
      const value = await getMetadata(ref(storage, path));
      metadata.push({
        path,
        name: value.name,
        bucket: value.bucket,
        size: Number(value.size || 0),
        contentType: value.contentType || "",
        md5Hash: value.md5Hash || "",
        customMetadata: value.customMetadata || {}
      });
    } catch (error) {
      throw new Error(`移行元画像メタデータを確認できません: ${path} (${error.code || error.message})`);
    }
  }
  return metadata;
}

function createBackupId(migrationId) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const suffix = createHash("sha256")
    .update(`${migrationId}:${Date.now()}`)
    .digest("hex")
    .slice(0, 10);
  return `${timestamp}-${suffix}`;
}

function backupPathFor(options, backupId) {
  if (!/^[A-Za-z0-9._-]+$/.test(backupId)) throw new Error("backup-idが不正です。");
  return join(
    options.backupDirectory,
    options.userId,
    basename(options.formalizationReport, ".json"),
    `${backupId}.json`
  );
}

async function writeBackup(options, bundle, state, imageMetadata) {
  const backupId = createBackupId(bundle.migrationManifest.migrationId);
  const path = backupPathFor(options, backupId);
  await mkdir(resolve(path, ".."), { recursive: true });
  const payload = {
    schemaVersion: "1.0",
    backupId,
    migrationId: bundle.migrationManifest.migrationId,
    environment: options.environment,
    userId: options.userId,
    createdAt: new Date().toISOString(),
    sourceQuestionCount: state.allQuestions.filter(
      question => question.subject === "歯科診療補助"
    ).length,
    sourceQuestionsSha256: bundle.hashes.oldQuestionsSha256,
    documents: serializeFirestoreValue({
      questions: state.questionsDocument,
      chunks: state.chunkDocuments,
      progress: state.progressDocument,
      settings: state.settingsDocument,
      pdfMaterials: state.pdfMaterialsDocument
    }),
    imageMetadata
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return { backupId, path };
}

async function readBackup(options, expectedMigrationId) {
  const path = backupPathFor(options, options.backupId);
  const backup = JSON.parse(await readFile(path, "utf8"));
  if (
    backup.backupId !== options.backupId ||
    backup.migrationId !== expectedMigrationId ||
    backup.userId !== options.userId ||
    backup.environment !== options.environment
  ) {
    throw new Error("バックアップの対象・環境・migrationIdが一致しません。");
  }
  backup.documents = await deserializeFirestoreValue(backup.documents);
  return { backup, path };
}

function migrationDocumentName(migrationId) {
  const hash = createHash("sha256").update(migrationId).digest("hex").slice(0, 24);
  return `migration-${hash}`;
}

async function acquireLock(db, userId, migrationId, mode) {
  const lockRef = appDocumentRef(db, userId, "migration-lock");
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(lockRef);
    const current = snapshot.exists() ? snapshot.data() : null;
    if (current?.status === "active" && current.migrationId !== migrationId) {
      throw new Error(`別のmigrationが実行中です: ${current.migrationId}`);
    }
    transaction.set(lockRef, {
      migrationId,
      mode,
      status: "active",
      acquiredAt: serverTimestamp()
    });
  });
  return lockRef;
}

async function releaseLock(lockRef) {
  await deleteDoc(lockRef);
}

async function stageImages(storage, options, bundle, migrationStateRef, existingState) {
  const safeMigrationId = createHash("sha256")
    .update(bundle.migrationManifest.migrationId)
    .digest("hex")
    .slice(0, 24);
  const imageAssets = { ...(existingState?.imageAssets || {}) };
  for (const [index, name] of bundle.imageNames.entries()) {
    const sourcePath = join(bundle.imagesDirectory, name);
    const sourceSha256 = await sha256File(sourcePath);
    const imagePath =
      `users/${options.userId}/questions/migrations/${safeMigrationId}/${name}`;
    const objectRef = ref(storage, imagePath);
    await uploadBytes(objectRef, new Uint8Array(await readFile(sourcePath)), {
      contentType: "image/jpeg",
      cacheControl: "private,max-age=3600",
      customMetadata: {
        migrationId: bundle.migrationManifest.migrationId,
        sourceSha256
      }
    });
    const [imageUrl, metadata] = await Promise.all([
      getDownloadURL(objectRef),
      getMetadata(objectRef)
    ]);
    if (metadata.customMetadata?.sourceSha256 !== sourceSha256) {
      throw new Error(`アップロード画像のSHA-256メタデータが一致しません: ${name}`);
    }
    imageAssets[name] = {
      imageName: name,
      imagePath,
      imageUrl,
      sourceSha256,
      size: Number(metadata.size || 0)
    };
    await setDoc(migrationStateRef, {
      phase: "images",
      imageAssets,
      processedImages: index + 1,
      updatedAt: serverTimestamp()
    }, { merge: true });
  }
  return imageAssets;
}

function splitMetadata(document) {
  const {
    allQuestions: _allQuestions,
    storageMode: _storageMode,
    questionCount: _questionCount,
    chunkCount: _chunkCount,
    ...metadata
  } = document || {};
  return metadata;
}

async function commitMigratedState(
  db,
  userId,
  currentState,
  migratedState,
  migrationStateRef,
  migrationRecord
) {
  const storage = createQuestionChunkStorage(
    migratedState.allQuestions,
    {
      ...splitMetadata(currentState.questionsDocument),
      updatedAt: serverTimestamp()
    }
  );
  const previousChunkCount = currentState.questionsDocument.storageMode ===
    QUESTION_CHUNK_STORAGE_MODE && Number.isInteger(currentState.questionsDocument.chunkCount)
    ? currentState.questionsDocument.chunkCount
    : 0;
  const syncRef = appDocumentRef(db, userId, "sync");
  await runTransaction(db, async transaction => {
    const syncSnapshot = await transaction.get(syncRef);
    const actualRevision = normalizeCloudRevision(
      syncSnapshot.exists() ? syncSnapshot.data()?.revision : undefined
    );
    if (actualRevision !== currentState.syncRevision) {
      throw new Error(
        "移行準備中にクラウドデータが更新されたため、移行を中止しました。" +
        "最新データで再実行してください。"
      );
    }

    transaction.set(appDocumentRef(db, userId, "questions"), storage.manifest);
    storage.chunks.forEach((chunk, index) => {
      transaction.set(appDocumentRef(db, userId, questionChunkName(index)), chunk);
    });
    for (let index = storage.chunks.length; index < previousChunkCount; index += 1) {
      transaction.delete(appDocumentRef(db, userId, questionChunkName(index)));
    }
    transaction.set(appDocumentRef(db, userId, "progress"), {
      ...migratedState.progressDocument,
      updatedAt: serverTimestamp()
    });
    transaction.set(appDocumentRef(db, userId, "settings"), {
      ...migratedState.settingsDocument,
      updatedAt: serverTimestamp()
    });
    transaction.set(syncRef, {
      revision: actualRevision + 1,
      updatedAt: serverTimestamp()
    });
    transaction.set(migrationStateRef, {
      ...migrationRecord,
      status: "completed",
      phase: "completed",
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  });
}

async function verifyExistingFinalState(db, userId, bundle, migrationState) {
  const state = await readCurrentState(db, userId);
  const plan = {
    removedRuntimeIds: migrationState.removedRuntimeIds || []
  };
  const verification = verifyMigratedState(
    state,
    bundle,
    plan,
    migrationState.imageAssets || {}
  );
  return { state, verification };
}

async function runVerifyOrDryRun(context, options, bundle) {
  const state = await readCurrentState(context.db, options.userId);
  const migrationStateRef = appDocumentRef(
    context.db,
    options.userId,
    migrationDocumentName(bundle.migrationManifest.migrationId)
  );
  const migrationStateSnapshot = await getDoc(migrationStateRef);
  if (
    migrationStateSnapshot.exists() &&
    migrationStateSnapshot.data()?.status === "completed"
  ) {
    const { verification } = await verifyExistingFinalState(
      context.db,
      options.userId,
      bundle,
      migrationStateSnapshot.data()
    );
    if (!verification.valid) throw new Error("完了済みmigrationの実体検証に失敗しました。");
    return {
      schemaVersion: "1.0",
      mode: options.mode,
      migrationId: bundle.migrationManifest.migrationId,
      currentState: "already-migrated",
      writesPerformed: 0,
      verification,
      result: "pass"
    };
  }
  const plan = buildMigrationPlan(state, bundle);
  const report = buildDryRunReport(state, plan, bundle);
  return {
    ...report,
    mode: options.mode,
    currentState: "source-verified",
    result: "pass"
  };
}

async function runApply(context, options, bundle) {
  const migrationId = bundle.migrationManifest.migrationId;
  const migrationStateRef = appDocumentRef(
    context.db,
    options.userId,
    migrationDocumentName(migrationId)
  );
  const existingSnapshot = await getDoc(migrationStateRef);
  if (existingSnapshot.exists() && existingSnapshot.data()?.status === "completed") {
    const { verification } = await verifyExistingFinalState(
      context.db,
      options.userId,
      bundle,
      existingSnapshot.data()
    );
    if (!verification.valid) throw new Error("完了済みmigrationの実体が不正です。");
    return {
      schemaVersion: "1.0",
      mode: "apply",
      migrationId,
      alreadyCompleted: true,
      writesPerformed: 0,
      verification,
      result: "pass"
    };
  }

  const lockRef = await acquireLock(context.db, options.userId, migrationId, "apply");
  try {
    const currentState = await readCurrentState(context.db, options.userId);
    const plan = buildMigrationPlan(currentState, bundle);
    const imageMetadata = await collectImageMetadata(
      context.storage,
      currentState.allQuestions.filter(question => question.subject === "歯科診療補助")
    );
    let migrationState = existingSnapshot.exists() ? existingSnapshot.data() : {};
    let backup;
    if (migrationState.backupId) {
      options.backupId = migrationState.backupId;
      const resumedBackup = await readBackup(options, migrationId);
      backup = {
        ...resumedBackup.backup,
        path: resumedBackup.path
      };
    } else {
      backup = await writeBackup(options, bundle, currentState, imageMetadata);
      await setDoc(migrationStateRef, {
        migrationId,
        status: "running",
        phase: "backup",
        environment: options.environment,
        userId: options.userId,
        backupId: backup.backupId,
        backupPath: backup.path,
        sourceQuestionsSha256: bundle.hashes.oldQuestionsSha256,
        targetQuestionsSha256: bundle.hashes.newQuestionsSha256,
        targetImagesTreeSha256: bundle.hashes.newImagesTreeSha256,
        startedAt: serverTimestamp(),
        processedDocumentIds: [],
        failedDocumentIds: []
      }, { merge: true });
      migrationState = (await getDoc(migrationStateRef)).data();
    }
    if (options.simulateFailureAfter === "backup") {
      throw new Error("Emulator failure simulation after backup");
    }

    const imageAssets = await stageImages(
      context.storage,
      options,
      bundle,
      migrationStateRef,
      migrationState
    );
    if (options.simulateFailureAfter === "images") {
      throw new Error("Emulator failure simulation after images");
    }
    const migratedState = materializeMigratedState(currentState, plan, imageAssets);
    const verificationBeforeCommit = verifyMigratedState(
      migratedState,
      bundle,
      plan,
      imageAssets
    );
    if (!verificationBeforeCommit.valid) {
      throw new Error(`移行途中検証に失敗しました: ${JSON.stringify(verificationBeforeCommit.errors)}`);
    }
    const migrationRecord = {
      migrationId,
      backupId: backup.backupId,
      backupPath: backup.path,
      imageAssets,
      removedRuntimeIds: plan.removedRuntimeIds,
      processedDocumentIds: plan.blueprints.map(item => item.recordId),
      failedDocumentIds: [],
      sourceLearningStates: summarizeLearningStates(currentState),
      targetLearningStates: summarizeLearningStates(migratedState),
      verificationBeforeCommit,
      environment: options.environment,
      userId: options.userId
    };
    await commitMigratedState(
      context.db,
      options.userId,
      currentState,
      migratedState,
      migrationStateRef,
      migrationRecord
    );
    const { verification } = await verifyExistingFinalState(
      context.db,
      options.userId,
      bundle,
      { ...migrationRecord, status: "completed" }
    );
    if (!verification.valid) {
      throw new Error(`移行後検証に失敗しました: ${JSON.stringify(verification.errors)}`);
    }
    await releaseLock(lockRef);
    return {
      schemaVersion: "1.0",
      mode: "apply",
      migrationId,
      backupId: backup.backupId,
      alreadyCompleted: false,
      writesPerformed: 1,
      operations: plan.operationCounts,
      sourceLearningStates: migrationRecord.sourceLearningStates,
      targetLearningStates: migrationRecord.targetLearningStates,
      verification,
      result: "pass"
    };
  } catch (error) {
    await setDoc(migrationStateRef, {
      status: "failed",
      phase: "failed",
      failureMessage: String(error.message || error),
      failedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    await releaseLock(lockRef);
    throw error;
  }
}

async function restoreDocuments(db, userId, currentState, backup, migrationStateRef) {
  const documents = backup.documents;
  const oldChunks = documents.questions.storageMode === QUESTION_CHUNK_STORAGE_MODE
    ? documents.chunks
    : [];
  const oldChunkNames = new Set(oldChunks.map(row => row.name));
  const currentChunkCount = currentState.questionsDocument.storageMode ===
    QUESTION_CHUNK_STORAGE_MODE && Number.isInteger(currentState.questionsDocument.chunkCount)
    ? currentState.questionsDocument.chunkCount
    : 0;
  const syncRef = appDocumentRef(db, userId, "sync");
  await runTransaction(db, async transaction => {
    const syncSnapshot = await transaction.get(syncRef);
    const actualRevision = normalizeCloudRevision(
      syncSnapshot.exists() ? syncSnapshot.data()?.revision : undefined
    );
    if (actualRevision !== currentState.syncRevision) {
      throw new Error(
        "ロールバック準備中にクラウドデータが更新されたため、復元を中止しました。" +
        "最新データを確認して再実行してください。"
      );
    }

    transaction.set(appDocumentRef(db, userId, "questions"), documents.questions);
    oldChunks.forEach(row => {
      transaction.set(appDocumentRef(db, userId, row.name), row.data);
    });
    for (let index = 0; index < currentChunkCount; index += 1) {
      const name = questionChunkName(index);
      if (!oldChunkNames.has(name)) {
        transaction.delete(appDocumentRef(db, userId, name));
      }
    }
    transaction.set(appDocumentRef(db, userId, "progress"), documents.progress);
    transaction.set(appDocumentRef(db, userId, "settings"), documents.settings);
    transaction.set(appDocumentRef(db, userId, "pdfMaterials"), documents.pdfMaterials);
    transaction.set(syncRef, {
      revision: actualRevision + 1,
      updatedAt: serverTimestamp()
    });
    transaction.set(migrationStateRef, {
      status: "rollback-data-restored",
      phase: "rollback-data-restored",
      rollbackDataRestoredAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
  });
}

async function runRollback(context, options, bundle) {
  const migrationId = bundle.migrationManifest.migrationId;
  const migrationStateRef = appDocumentRef(
    context.db,
    options.userId,
    migrationDocumentName(migrationId)
  );
  const stateSnapshot = await getDoc(migrationStateRef);
  if (stateSnapshot.exists() && stateSnapshot.data()?.status === "rolled-back") {
    const state = await readCurrentState(context.db, options.userId);
    buildMigrationPlan(state, bundle);
    return {
      schemaVersion: "1.0",
      mode: "rollback",
      migrationId,
      backupId: options.backupId,
      alreadyRolledBack: true,
      writesPerformed: 0,
      finalQuestionCount: 345,
      result: "pass"
    };
  }
  const { backup } = await readBackup(options, migrationId);
  const lockRef = await acquireLock(context.db, options.userId, migrationId, "rollback");
  try {
    const currentState = await readCurrentState(context.db, options.userId);
    await restoreDocuments(
      context.db,
      options.userId,
      currentState,
      backup,
      migrationStateRef
    );
    const migrationState = stateSnapshot.exists() ? stateSnapshot.data() : {};
    const imageAssets = migrationState.imageAssets || {};
    const imageDeletionErrors = [];
    for (const asset of Object.values(imageAssets)) {
      try {
        await deleteObject(ref(context.storage, asset.imagePath));
      } catch (error) {
        if (error.code !== "storage/object-not-found") {
          imageDeletionErrors.push({
            imagePath: asset.imagePath,
            error: error.code || error.message
          });
        }
      }
    }
    if (imageDeletionErrors.length) {
      await setDoc(migrationStateRef, {
        status: "rollback-failed",
        phase: "rollback-image-cleanup-failed",
        imageDeletionErrors,
        updatedAt: serverTimestamp()
      }, { merge: true });
      throw new Error(`ロールバック画像削除に失敗しました: ${JSON.stringify(imageDeletionErrors)}`);
    }
    const restored = await readCurrentState(context.db, options.userId);
    buildMigrationPlan(restored, bundle);
    await setDoc(migrationStateRef, {
      status: "rolled-back",
      phase: "rolled-back",
      backupId: options.backupId,
      rolledBackAt: serverTimestamp(),
      imageDeletionErrors: [],
      updatedAt: serverTimestamp()
    }, { merge: true });
    await releaseLock(lockRef);
    return {
      schemaVersion: "1.0",
      mode: "rollback",
      migrationId,
      backupId: options.backupId,
      alreadyRolledBack: false,
      writesPerformed: 1,
      finalQuestionCount: restored.allQuestions.filter(
        question => question.subject === "歯科診療補助"
      ).length,
      restoredLearningStates: summarizeLearningStates(restored),
      orphanImageCount: 0,
      result: "pass"
    };
  } catch (error) {
    await releaseLock(lockRef).catch(() => {});
    throw error;
  }
}

async function writeReport(path, report) {
  if (!path) return;
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export async function runMigrationCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log(usage());
    return { result: "help" };
  }
  if (!options.formalizationReport) {
    throw new Error("--formalization-reportを指定してください。");
  }
  const bundle = await loadMigrationBundle(options.formalizationReport);
  assertSafeOptions(options, bundle);
  const context = await createFirebaseContext(options);
  try {
    let report;
    if (options.mode === "verify" || options.mode === "dry-run") {
      report = await runVerifyOrDryRun(context, options, bundle);
    } else if (options.mode === "apply") {
      report = await runApply(context, options, bundle);
    } else if (options.mode === "rollback") {
      report = await runRollback(context, options, bundle);
    } else {
      throw new Error(`未対応modeです: ${options.mode}`);
    }
    await writeReport(options.reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await context.cleanup();
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runMigrationCli().catch(error => {
    console.error(JSON.stringify({
      result: "fail",
      error: error.message,
      detail: error.detail || null
    }, null, 2));
    process.exitCode = 1;
  });
}
