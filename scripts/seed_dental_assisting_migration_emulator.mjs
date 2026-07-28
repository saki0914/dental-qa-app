#!/usr/bin/env node
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";

import {
  loadMigrationBundle
} from "./lib/dental-assisting-migration-core.mjs";
import {
  createEmulatorUser,
  DEFAULT_FORMALIZATION_REPORT,
  EMULATOR_PROJECT_ID,
  runMigrationCli,
  seedOldFormal
} from "../tests/helpers/dental-assisting-migration-fixture.mjs";

function readOption(name, fallback = undefined) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const email = readOption("--email", `migration-ui-${Date.now()}@example.test`);
const password = readOption("--password", "DentalMigrationUI!123");
const formalizationReport = readOption(
  "--formalization-report",
  DEFAULT_FORMALIZATION_REPORT
);
const testEnvironment = await initializeTestEnvironment({
  projectId: EMULATOR_PROJECT_ID
});

try {
  const bundle = await loadMigrationBundle(formalizationReport);
  const user = await createEmulatorUser({ email, password });
  const source = await seedOldFormal({
    testEnvironment,
    bundle,
    userId: user.userId
  });
  const dryRun = runMigrationCli({
    userId: user.userId,
    formalizationReport,
    args: ["--dry-run"]
  });
  const applied = runMigrationCli({
    userId: user.userId,
    formalizationReport,
    args: ["--apply"]
  });
  process.stdout.write(`${JSON.stringify({
    email,
    password,
    userId: user.userId,
    sourceQuestionCount: source.allQuestions.length,
    dryRun,
    applied
  }, null, 2)}\n`);
} finally {
  await testEnvironment.cleanup();
}
