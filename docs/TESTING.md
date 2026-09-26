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
npm run test:unit
npm run test:rules
npm run test:e2e
npm run test:e2e:authenticated
npm run test:e2e:headed
npm run test:e2e:report
npm run test:all
```

`npm run test:e2e`はPlaywrightの`webServer`設定により、テスト前に既存の`npm run dev`を起動します。CI以外では既存の`http://127.0.0.1:3000`サーバーを再利用できます。`npm run test:e2e:authenticated`はFirebase Local Emulator Suite上でテストユーザーを作成し、FirestoreとStorageへの保存を検証します。本番Firebaseは使用しません。

`npm run local:start:lan`は実機確認専用です。Emulatorを全ネットワークインターフェースへ公開するため、信頼できる私用LAN以外では実行しないでください。公共Wi-Fiでは使用せず、確認後は必ず終了してください。

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
- Firebase Emulator上でのログイン後の問題CRUD、一括登録・削除、進捗保存
- Firebase Emulator上での画像教材アップロード・更新・削除とマスク操作
- 実行時に生成した複数ページPDFの画像変換、Firestore・Storageへの永続化
- PDF変換後の中間アップロード失敗時に、先行して保存したページ画像を削除すること
- 白紙・横罫線・PDFノートの作成とページ順
- ペン、画像、ノート専用マスクのページ単位保存と再読込
- 画像Storage失敗時のIndexedDB保持と再読込後の再送
- ページ追加・並び替え・削除時の`orderRevision`競合検出と再試行
- ノートPDFの生成、ダウンロード、0バイト防止、ページ数
- PDFノートが既存`pdfMaterials`へ追加されないこと
- 教材から既定ノートを繰り返し開いても重複作成しないこと
- ノート用Firestore・Storageの所有者、サイズ、MIMEルール
- 教材を`archiving`状態へ先にロックし、`materialRefs`で取得した連携ノートを最大500件ずつ論理削除してから教材更新・削除を確定すること
- `archiving`中の教材から新しい連携ノートを作成できないこと
- ノートPDFは端末へのダウンロード・共有だけを行い、StorageへのPDFアップロードを許可しないこと

未ログインE2Eは管理操作を行わず、認証付きE2Eは`demo-dental-qa`のFirebase Emulatorだけを使用します。どちらもFirebase本番データへの書き込み・更新・削除は行いません。

## 現在の対象外

- 本番環境の実ユーザーでのログイン・新規登録
- 本番Firestore・Storageへの書き込み
- PDF取込（pdf.js）に使う外部CDNが停止・遮断された場合の代替経路
- 進捗リセット
- ソフトウェアキーボード
- iPhone・iPad実機固有の操作
- ピクセル単位のスクリーンショット比較
- iPadのプレビューアプリからの実クリップボード画像
- Web Share APIの実共有シート

ノートPDFの出力に使うpdf-libは`vendor/pdf-lib/`からローカル読込します。一方、PDF取込とページ画像化に使うpdf.jsは引き続き外部CDN依存で、両者は別の処理経路です。生成したPDFはブラウザ内で作成し、ダウンロードまたはWeb Share APIへ渡すだけで、Firebase Storageへ保存しません。

認証付きテストはFirebase Local Emulator Suite内で完結させ、本番Firebaseへの接続試行もテスト中に遮断・検出します。

## 手動確認が必要な項目

- iPhone実機
- iPad実機
- Safari実機
- ピンチズーム
- マスクのドラッグ
- ソフトウェアキーボード表示時
- 画面回転
- 本番公開後

Playwrightの端末エミュレーションは実機確認の代わりにはなりません。特にiPhone/iPadのSafari、タッチ、ピンチズーム、ソフトウェアキーボード、画面回転は実機で確認してください。

## 禁止事項

- 本番データを使った削除テスト
- 本番Storageへのアップロードテスト
- 実ユーザー認証情報のテストコードへの記載
- パスワードやトークンのコミット
- GitHub Secret scanningアラートの操作
- テストを通すための`index.html`変更

## セレクター方針

UI変更時も安定したセレクターを付与します。優先順位は次の通りです。

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

- 視覚回帰テスト
- GitHub ActionsによるCI
