# Testing

このプロジェクトでは、UIとコード整理の前に現在の未ログイン状態の表示と基本動作を守るため、Playwright Testによる読み取り専用の回帰テストを追加しています。

## 初回セットアップ

Dev Container内で次を実行します。

```bash
npm install
```

PlaywrightのブラウザとOS依存パッケージは、Dev Containerの`postCreateCommand`で次が実行される設定です。

```bash
npx playwright install --with-deps chromium webkit
```

Dev Containerを再構築した後は、`postCreateCommand`が完了していることを確認してください。手動で再実行する場合も同じコマンドを使います。ChromiumとWebKitを使用します。Firefoxは今回の必須対象ではありません。

この方法を採用している理由は、コンテナ再構築後に同じ手順でブラウザとOS依存パッケージを準備でき、通常の実行ユーザーを`node`のまま維持できるためです。`privileged`、Docker socketマウント、ホストのホーム全体や`~/.ssh`のマウントは使用しません。

## 通常のテスト実行

```bash
npm run check
npm run test:e2e
npm run test:e2e:headed
npm run test:e2e:report
npm run test:all
```

`npm run test:e2e`はPlaywrightの`webServer`設定により、テスト前に既存の`npm run dev`を起動します。CI以外では既存の`http://127.0.0.1:3000`サーバーを再利用できます。

## 現在の自動テスト範囲

- 未ログイン状態
- トップページ表示
- ログインUI表示
- 学習、問題管理、進捗、画像暗記のDOM存在確認
- 未ログイン時の危険な操作ボタンの非表示または無効状態
- レスポンシブ初期表示
- body全体の意図しない横スクロール
- リソースエラー
- JavaScriptの`pageerror`
- `console.error`の収集と失敗扱い
- Firebaseへの危険な書き込み系通信が発生していないこと

テストはログインせず、管理操作をクリックせず、Firebase本番データへ書き込み・更新・削除を行わない前提です。

## 現在の対象外

- 実ユーザーでのログイン
- 新規登録
- 問題CRUD
- 一括登録
- 一括削除
- 画像・PDFアップロード
- 画像削除
- 教材削除
- マスク追加
- マスク削除
- 進捗保存・リセット
- Firebaseへの書き込み
- ピンチズーム
- ソフトウェアキーボード
- iPhone・iPad実機固有の操作
- ピクセル単位のスクリーンショット比較

ログイン後機能は本番Firebaseに影響する可能性があるため、Firebase Local Emulator Suiteやテスト専用アカウントを整備するまで自動化しません。

## 手動確認が必要な項目

- iPhone実機
- iPad実機
- Safari実機
- ピンチズーム
- マスクのドラッグ
- ソフトウェアキーボード表示時
- 画面回転
- GitHub Pages公開後

Playwrightの端末エミュレーションは実機確認の代わりにはなりません。特にiPhone/iPadのSafari、タッチ、ピンチズーム、ソフトウェアキーボード、画面回転は実機で確認してください。

## 禁止事項

- 本番データを使った削除テスト
- 本番Storageへのアップロードテスト
- 実ユーザー認証情報のテストコードへの記載
- パスワードやトークンのコミット
- GitHub Secret scanningアラートの操作
- テストを通すための`index.html`変更

## セレクター方針

`index.html`は変更せず、既存DOMだけを使います。優先順位は次の通りです。

1. 既存の`id`
2. roleとaccessible name
3. label
4. 安定したclass
5. 表示テキスト

深いCSS階層セレクター、過度な`nth-child`、表示順だけに依存する指定は避けます。

## 既知の非推奨警告

`npm run dev`実行時、`http-server`の実行中にNode.jsから次の非推奨警告が出ることがあります。

```text
[DEP0066] DeprecationWarning: OutgoingMessage.prototype._headers is deprecated
```

これはアプリ本体ではなく、開発サーバーとして使っている`http-server`側の間接的な警告です。現時点ではHTTP 200確認とPlaywright実行を妨げていません。Playwright導入と同時に`http-server`を更新・置換せず、別ブランチで依存更新として扱うのが安全です。

## 今後の課題

- Firebase Local Emulator Suite
- テスト専用アカウント
- ログイン後テスト
- CRUDテスト
- Storageテスト
- マスク操作テスト
- 視覚回帰テスト
- GitHub ActionsによるCI
