# ローカル確認環境

Dental QA Appのノート、画像暗記、問題管理を、本番Firebaseへ接続せずに確認する手順です。通常はDev Container内のターミナルで実行してください。

## 初回準備

1. リポジトリをVS Codeで開きます。
2. 「Reopen in Container」でDev Containerを起動します。
3. ターミナルで次を実行します。

```bash
npm install
```

Dev ContainerにはJava、Firebase CLI、Chromium、WebKitを用意します。ホスト側へJavaを別途インストールする必要はありません。

## 1コマンドで起動

```bash
npm run local:start
```

起動後、ターミナルへ表示される次のURLを開きます。

- アプリ: `http://localhost:3000/?firebaseEmulator=1`
- Firebase Emulator UI: `http://localhost:4000`

ローカル確認用ログイン情報:

- メール: `local-note-test@example.com`
- パスワード: `LocalNoteTest123!`

画面上部に `LOCAL / FIREBASE EMULATOR` と、Auth・Firestore・Storageの接続先が表示されます。この表示がない場合はローカル確認を続けないでください。`?firebaseEmulator=1`での接続に失敗しても本番Firebaseへ切り替わる処理はありません。

終了するには、起動したターミナルで `Ctrl + C` を押します。終了時にEmulatorデータを `.firebase-emulator-data/` へ書き出します。このディレクトリはGit管理外です。

## 動作確認の目安

1. ローカル確認用ユーザーでログインします。
2. 「ノート・画像暗記」→「ノート」を開きます。
3. 白紙または横罫線ノートを作ります。
4. ペン、ハイライト、図形、テキスト、暗記マスクを追加します。
5. 画像ツールから画像を選択、または貼り付けます。
6. ノートへページを追加し、保存済み表示を確認します。
7. ページを再読み込みし、ノートと編集内容が戻ることを確認します。
8. 「PDFを書き出す」からAI共有用PDFを作り、ページ数と内容を確認します。
9. PDFノートではファイルを選択し、PDFページ順、背景、書き込み、再読込を確認します。

PDF原本はStorageへ保存しません。PDFから生成したページ画像だけをノート専用パスへ保存します。生成した書き出しPDFもFirebaseへ自動保存しません。

## 疎通確認

ローカル環境を起動したまま、別ターミナルで実行します。

```bash
npm run local:smoke
```

次を確認します。

- `index.html`をHTTPで取得できる
- ローカルAuthユーザーへログインできる
- Firestore Emulatorへ保存・読込できる
- Storage Emulatorへ画像を保存・読込・削除できる
- 使用プロジェクトが `demo-dental-qa` である

## 初期データの再作成

Emulatorが停止していることを確認してから実行します。

```bash
npm run local:reset
```

`.firebase-emulator-data/`を削除し、ローカルユーザーと空の問題・進捗・画像教材データを再作成します。本番Firebaseは変更しません。

IndexedDBの下書きも消す場合は、ブラウザの開発者ツールから次を削除してください。

```text
dentalQaNoteLocal
```

ユーザーを再作成するだけなら次を使用できます。

```bash
npm run local:seed
```

## 自動テスト

```bash
npm run test:all
```

個別実行:

```bash
npm run check
npm run test:unit
npm run test:rules
npm run test:e2e
npm run test:e2e:authenticated
```

認証付きE2Eは `demo-dental-qa` のEmulatorだけを使用します。

## iPadを同じLANから接続する

この操作だけはDev Container内ではなく、Macホストのターミナルで実行します。

```bash
npm run local:start:lan:host
```

このコマンドはDocker/仮想インターフェースを候補から除外し、MacホストのプライベートIPv4だけを案内します。Macホスト自体が`172.16/12`のLANを利用している場合は、仮想インターフェースを除外したうえで候補にできます。アプリとEmulatorの5ポート（3000/4000/8080/9099/9199）がそのアドレスで応答した後にだけURLを表示します。自動検出できない場合は、MacのプライベートIPv4を明示します。

```bash
DENTAL_LAN_HOST=192.168.1.20 npm run local:start:lan:host
```

信頼できる私用LANでだけ実行してください。

Dev Container内で`npm run local:start:lan`を実行した場合は、検出される`172.16/12`のDocker内IPをiPad用URLとして表示せず、上記のMacホスト用コマンドを案内して停止します。

Macホスト側の`local:start:lan:host`で到達性確認が完了すると、ターミナルへiPad用URLが表示されます。例:

```text
http://192.168.x.x:3000/?firebaseEmulator=1
```

PCのファイアウォールで、同一LANから次のポートへの接続を許可します。

SafariからのLAN接続はHTTPのためsecure contextではありません。Clipboard APIの直接読取が拒否される場合は、画面の案内に従って長押しペースト、写真選択、またはファイル選択を使用してください。

| 用途 | ポート |
|---|---:|
| アプリ | 3000 |
| Emulator UI | 4000 |
| Firestore | 8080 |
| Authentication | 9099 |
| Storage | 9199 |

LANモードはHTTPです。SafariのClipboard APIは安全なコンテキスト制約により利用できない場合があります。その場合は、長押しペースト、`paste`イベント、写真選択、ファイル選択を使用してください。公共Wi-Fiや共有ネットワークでは起動しないでください。

## トラブルシューティング

### ポートが使用中

別の `npm run local:start`、Firebase Emulator、`npm run dev` を停止してから再実行します。Emulator UIのポートは4000です。

### Emulatorへ接続できない

URLに `?firebaseEmulator=1` があるか確認します。LAN接続では、ブラウザで開いたPCのプライベートIPv4アドレスをEmulator接続先として使用します。不正な `emulatorHost` が指定された場合は初期化を停止し、本番Firebaseへフォールバックしません。

### ログインできない

`npm run local:seed`を実行し、上記のメールとパスワードを使います。Emulator UIのAuthentication画面でもユーザーを確認できます。

### Storage保存に失敗する

0バイト、20MB超、またはPNG・JPEG・WebP以外の画像はノート用Storageルールで拒否されます。ページ内容JSONは `application/json` だけを許可します。

### PDF読込に失敗する

0バイトでないこと、ファイル先頭がPDFシグネチャであること、暗号化や破損がないことを確認します。拡張子だけではPDFとして扱いません。

### 画像を貼り付けられない

Clipboard APIが拒否された場合、画像ツールから「クリップボードから貼り付け」を選び、表示される領域を長押しして「ペースト」を選びます。写真・ファイル選択も利用できます。

### PDFを書き出せない

背景画像や貼り付け画像を取得できない場合は、欠けたまま完成扱いにせずエラーになります。Emulatorを起動し直し、低い画質プリセットでも確認してください。
