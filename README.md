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
- 学習ノート（手書き・画像・暗記マスク・PDF出力）

## 使い方

### 1. Firebase の設定を入れる
`js/config/firebase.js` の `PRODUCTION_FIREBASE_CONFIG` を、自分の Firebase プロジェクトの値に置き換えてください。

### 2. Authentication を有効化する
Firebase で **Email/Password** を ON にしてください。

このアプリは既存ユーザー専用のため、新規登録画面を提供していません。ただし、画面を隠すだけではFirebase Authentication APIからの登録を防げません。Google Cloud Consoleの **Identity Platform > 設定 > User actions** で、エンドユーザーによるアカウント作成を無効にしてください。既存アカウントでのログインは引き続き利用できます。

参考: [Identity Platformでユーザー操作を無効にする](https://docs.cloud.google.com/identity-platform/docs/concepts-manage-users#disable_user_actions)

### 3. Firestore を有効化する
Cloud Firestore を作成してください。

### 4. Firebase ルールを反映する
同梱の `firestore.rules` と `storage.rules` を使ってください。Storageは `users/{uid}/...` 配下を、そのユーザー本人だけが読み書きできる設定です。

Firebase CLIで反映する場合は、プロジェクトルートで次を実行します。

ノートschemaを変更するリリースでは、先にHostingへアプリコードを反映し、その後にFirestore rulesを反映してください。開いたままの旧タブやHosting配信の短時間のずれがある状態でrulesだけを先に厳格化すると、旧クライアントの新規作成が拒否される可能性があります。現在のrulesは既存documentとの互換性のため、対象fieldが存在する場合だけ型・enum・pathを検証します。

```bash
firebase deploy --project production --only firestore:rules,storage
```

Cloud Storage for Firebaseを利用するには、FirebaseプロジェクトのBlazeプランと有効な請求先アカウントも必要です。課金アカウントが無効な場合、保存済み画像を含むStorageアクセスが402または403で失敗します。

### JavaScriptの構成

- `js/app.js`: 学習画面、認証、アプリ全体の状態調停
- `js/config/`: Firebaseの接続設定
- `js/core/`: テキスト正規化やエラー分類などのブラウザ非依存ロジック
- `js/features/`: 問題管理と画像暗記の画面・状態・操作
- `js/services/`: Firestoreの読込・書込

画像付き問題の一括登録形式とMac/iPhone/iPadでの運用は、[`docs/QUESTION_IMPORT.md`](docs/QUESTION_IMPORT.md)を参照してください。

ノートから生成するPDFは端末へのダウンロードまたは対応端末の共有シートにだけ渡し、Firebase Storageには保存しません。PDF出力用のpdf-libはリポジトリ内へ固定していますが、PDF取込用のpdf.jsは別ライブラリで、現在は外部CDNから読み込みます。

教材を削除またはページ数を変えて差し替える場合、先に教材を`archiving`として保存し、連携ノートのルート文書を最大500件ずつのFirestore batchで論理削除します。復旧と後続クリーンアップのためpages/assetsサブコレクションはその場では削除しません。ページ数を変えた差し替えでは教材レコードの既定ノートIDを更新し、旧ノートを復元せず新しい既定ノートを作成します。

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

Emulatorは実在しない `demo-dental-qa` プロジェクトIDに固定されています。ローカル一式は `npm run local:start` で起動し、`http://localhost:3000/?firebaseEmulator=1` を開きます。初期データ作成、疎通確認、保存データの初期化には、それぞれ `npm run local:seed`、`npm run local:smoke`、`npm run local:reset` を使用できます。

同じLAN上のiPadなどから確認する場合だけ、Macホスト側のターミナルで `npm run local:start:lan:host` を使用します。このモードはHTTPサーバーとFirebase Emulatorを `0.0.0.0` へバインドし、Docker/仮想インターフェースを除外して選んだMacのプライベートIPv4を案内します。Dev Container内の `npm run local:start:lan` はDocker内IPを案内せず、Macホストで実行するコマンドを表示して停止します。信頼できる私用LANでのみ起動し、公共Wi-Fi・共有ネットワークでは使用しないでください。確認後はプロセスを終了し、OSのファイアウォールでポート3000/4000/8080/9099/9199を外部へ公開しないでください。

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
