# Dental QA Ultimate

一問一答形式の歯科学習アプリです。  
今回入っている主な機能は次の通りです。

- iPhone版
  - 問題 → 答え → 解説
- iPad版
  - 解答欄あり
  - 複数回答対応
  - 自動判定
- 苦手復習
- 教科別進捗
- 問題の検索 / 追加 / 更新 / 削除
- メールアドレス + パスワードでログイン
- Firestore へのクラウド保存

## 使い方

### 1. Firebase の設定を入れる
`js/firebase-config.js` の `PRODUCTION_FIREBASE_CONFIG` を、自分の Firebase プロジェクトの値に置き換えてください。

### 2. Authentication を有効化する
Firebase で **Email/Password** を ON にしてください。

### 3. Firestore を有効化する
Cloud Firestore を作成してください。

### 4. Firebase ルールを反映する
同梱の `firestore.rules` と `storage.rules` を使ってください。Storageは `users/{uid}/...` 配下を、そのユーザー本人だけが読み書きできる設定です。

Firebase CLIで反映する場合は、プロジェクトルートで次を実行します。

```bash
firebase deploy --project production --only firestore:rules,storage
```

Cloud Storage for Firebaseを利用するには、FirebaseプロジェクトのBlazeプランと有効な請求先アカウントも必要です。課金アカウントが無効な場合、保存済み画像を含むStorageアクセスが402または403で失敗します。

### 5. 公開する
GitHub Pages などに `index.html` を置けば使えます。

## 問題データの考え方

このアプリは、問題データを次の項目で管理します。

- 教科
- 問題
- 答え（複数可）
- 解説

## iPad判定の仕様

- 改行 / 読点 / カンマ / 中点 で複数回答を区切れます
- 完全一致なら正解
- 一部不足なら惜しい
- 足りない答えや余計な答えを表示します

## おすすめの使い方

- iPhoneで通学中に確認
- iPadで家で書いて判定
- 苦手だけ復習で弱点潰し
- 問題管理画面で教科書ベースの問題を追加

## Dev Container での開発

このリポジトリには、macOS + Rancher Desktop + VS Code Dev Containers 向けの開発環境を同梱しています。

### 必要なもの

- Rancher Desktop
- VS Code
- VS Code Dev Containers 拡張機能

Dev Containerを使わずFirebase Emulator Suiteを実行する場合は、Node.js 22とJava 21以降も必要です。

### 開き方

1. Rancher Desktop を起動します。
2. VS Code でこのプロジェクトフォルダを開きます。
3. Command + Shift + P を押します。
4. `Dev Containers: Rebuild and Reopen in Container` を選びます。
5. コンテナ内ターミナルで次を確認します。

```bash
git --version
node --version
npm --version
codex --version
```

### ローカル表示

Dev Container 内で次を実行します。

```bash
npm run dev
```

VS Code が転送する `http://localhost:3000` をMac側ブラウザで開きます。Firebase Authentication の制約を避けるため、`file://` ではなくHTTP経由で確認してください。

### テスト

通常の構文・単体・未ログインE2Eは次で実行します。

```bash
npm run check
npm run test:unit
npm run test:e2e
```

Firestore/Storageルールとログイン後E2EはFirebase Emulator Suiteを自動起動して実行します。

```bash
npm run test:rules
npm run test:e2e:authenticated
```

Emulatorは実在しない `demo-dental-qa` プロジェクトIDに固定されています。アプリ側の接続切替も `localhost` または `127.0.0.1` で `?firebaseEmulator=1` を指定した場合だけ有効です。手動確認では、別ターミナルで `npm run emulators:start` を起動してから `http://localhost:3000/?firebaseEmulator=1` を開きます。

Firebase CLIのデフォルトプロジェクトも誤操作防止のため `demo-dental-qa` です。本番へルールを反映するときだけ、上記のように `--project production` を明示してください。

### Codex CLI

Codex CLI はDev Containerイメージのビルド時にnpmから導入します。初回はコンテナ内で次を実行し、画面の案内に従ってログインします。

```bash
codex
```

Codex の認証情報はコンテナ専用のDocker Volumeに保存されます。Mac側の `~/.codex`、`~/.ssh`、ホームディレクトリ全体はDev Containerへマウントしていません。

### 注意

- 開発サーバーはポート3000だけを転送します。
- Firebase本番データに対する追加、更新、削除の操作は、内容を確認してから実行してください。
- Dev Containerを作り直してもCodex認証用Volumeは残ります。完全に消したい場合は、Docker Volume `dental-qa-app-codex` を削除します。
