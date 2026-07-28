# 移行UIスモークテスト

## 環境

- Firebase Auth / Firestore / Storage Emulator
- project: `demo-dental-qa`
- Playwright `iPad Portrait`
- viewport: 768 × 1024
- 本番リクエスト遮断ガード: 有効
- 本番へのリクエスト: 0件

## 実施内容

- 旧正式345問と仮学習状態をEmulatorへ投入
- 専用CLIをdry-run
- Emulatorへapply
- 同一migrationを再applyし、書込み0件を確認
- 学習アプリへEmulatorユーザーでログイン
- 歯科診療補助350問を読込
- 4肢択2を逆順、大文字、全角英字を含む入力で正解判定
- 同じ選択肢の重複入力を不正解判定
- `orderedAnswers: true` の複数穴埋めで逆順不正解・正順正解
- 4肢択1
- 単一回答
- 状況設定
- 新しいexplanation表示
- 画像問題21問・画像17件の実表示
- 同一画像を別観点で使う2問の同一Storage URL参照
- 統合後問題
- answers修正問題
- 「次へ」「戻る」
- 最後にrollbackし、345問と全学習状態を復元

## 結果

すべて合格。page error 0件、production request 0件、画像404 0件、表示不能画像0件だった。

スクリーンショット: `screenshots/migration-ipad-smoke.png`

Codexの対話ブラウザ接続ツールはこのセッションでは公開されていなかったため、追加の対話ブラウザ操作は未実施。既存アプリのPlaywright実ブラウザテストで、同等の操作と画面保存を実施した。

