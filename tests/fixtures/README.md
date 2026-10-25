# テスト用ファイル

## pdf-embedded-cid-cff-ja.pdf

改訂17・18のPDF変換テスト（`tests/e2e/pdf-embedded-fonts.spec.mjs`）で使う1ページのPDF。

- 1行目「埋め込み日本語の文字が消えない」: CID-keyed CFFの日本語フォントを埋め込み（`/CIDFontType0`、`/FontFile3`の`/CIDFontType0C`、`/Identity-H`、ToUnicodeなし）、CIDSystemInfoは`Adobe-Identity-0`。フォントはNoto Sans CJK JP Regular（SIL Open Font License 1.1）を、この行の15文字だけに絞ったもの。
- 2行目「Helvetica 123」: 埋め込みなしのHelvetica。
- 青い四角形。
- 4行目（改訂18）: 1行目と同じフォントを、CIDSystemInfoを`Adobe-Japan1-6`として使う（ToUnicodeなし）。Appleの端末で作ったPDFがヒラギノを埋め込む形と同じで、pdf.jsはこの行を描くのに`Adobe-Japan1-UCS2`のCMapを読む。1行目のフォントと同じものとみなされないよう、幅の指定（`/W [0 [1000]]`、CID 0の既定の幅）を持つ。

fontToolsで`NotoSansCJK-Regular.ttc`の日本語版をこの文字だけにサブセットし、`CFF `表をそのまま`/FontFile3`に入れて作った（4行目のフォントは同じ`/FontFile3`を使う。5.0KB）。
