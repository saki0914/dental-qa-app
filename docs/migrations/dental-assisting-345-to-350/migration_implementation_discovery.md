# 移行実装調査

## 対象

- アプリ: `/Users/sakin/dev/dental-qa-app`
- ブランチ: `main`
- 調査開始時HEAD: `e5760aa`
- 調査開始時の作業ツリー: clean
- 旧正式run: `/Users/sakin/Library/Mobile Documents/com~apple~CloudDocs/歯科診療補助/教科書/subject/runs/20260727-113219-language-quality-final`
- 新正式run: `/Users/sakin/Library/Mobile Documents/com~apple~CloudDocs/歯科診療補助/教科書/subject/runs/20260728-012040-national-exam-semantic-quality-final`
- 新正式runは、同runの `formalization_report.json` から取得した。パスの類似推定は使用していない。

## アプリ構成

- 静的HTML/CSSとES Modules
- Firebase Browser SDK
- Firebase Authentication / Firestore / Storage
- Node.jsの単体・ルールテスト
- Playwrightの画面テスト
- Firebase Emulator: Auth `9099`、Firestore `8080`、Storage `9199`
- ローカル起動: `npm run dev`
- 全テスト: `npm run test:all`

## Firestoreと学習状態

- 対象collectionは `users/{uid}/app`。
- 問題は問題ごとのFirestore documentではなく、`questions`管理文書と `questions-####` 分割文書内の配列要素として保存される。
- 配列要素の `id` がアプリ内の安定識別子である。
- 学習状態は `users/{uid}/app/progress.questionStatuses[id]` に保存される。
- 状態値は、キーなしが未回答、`1`が「できる」、`2`が「まだ」。
- 苦手一覧は `wrongQuestionIds` に保存される。
- 画像は `users/{uid}/questions/...` のStorage objectを参照し、問題には `imageName`、`imagePath`、`imageUrl` が保存される。

## 既存一括登録

- `js/features/question-manager.js` の一括登録は追加登録用である。
- 問題文等による重複スキップを行うが、345→350の差分移行、旧レコードの統合・置換、全解説更新、学習状態変換には対応しない。
- 既存一括登録は今回の移行には使用しない。

## 正解判定

- 変更前は `js/app.js` 内で問題文の「a〜d」等を見て順序固定を推測していた。
- 順不同比較はSet相当の包含判定で、多重度を厳密に扱わなかった。
- 新実装は `js/core/answer-comparison.js` へ分離し、`orderedAnswers === true` の場合だけ順序を区別する。

## Emulator切替

- `?firebaseEmulator=1` はlocalhost系ホストだけで有効になる。
- Emulator用Firebase project IDは `demo-dental-qa`。
- 本番FirebaseとEmulatorの接続先はコード上で分離されている。
- 本タスクの実行では本番Firestore、Storage、Authへ接続していない。

## 実装先

- 専用CLI: `scripts/migrate_dental_assisting_345_to_350.mjs`
- 移行コア: `scripts/lib/dental-assisting-migration-core.mjs`
- 回答比較: `js/core/answer-comparison.js`
- Emulator移行テスト: `tests/rules/dental-assisting-migration.emulator.test.mjs`
- UI移行テスト: `tests/e2e/dental-assisting-migration.spec.mjs`
- 単体テスト: `tests/unit/dental-assisting-migration.test.mjs`、`tests/unit/answer-comparison.test.mjs`

