# Pixel Codex V1.5.1 リリースノート

## 配布物

- `Pixel-Codex-windows-x64-1.5.1.zip`
- 対象: Windows 10 / 11、x64
- 起動方法: ZIPを任意のフォルダへ展開し、`PixelCodex.exe`を実行
- SHA-256: `7DCE4E58A629B1F4EF8D69A6FC353A68199BE6566AE283BBE924D5C7A544DD0D`

Codex CLIは同梱していません。あらかじめCodexデスクトップ版またはCodex CLIを導入し、ログインを済ませてください。詳しい条件は[動作環境](pc-requirements.md)を参照してください。

## 変更点

- 最新のデスクトップ版を、GitHub Releasesから直接ダウンロードできるWindows ZIPとして公開
- Androidコンパニオンで、承認待ち・質問待ちを「作業中」と区別して表示
- 承認・質問が届いたときにAndroid端末の通知音を鳴らし、回答欄を画面上部へ表示
- Androidコンパニオンの4タブを1行表示へ調整
- READMEに製品画面、会計画面、最新版のダウンロード導線を追加

## 利用時の注意

- Windows版のみです。macOS・Linux版はありません
- コード署名をしていないため、Windows SmartScreenやブラウザの警告が表示される場合があります
- 自動更新はありません。新しい版はGitHub Releasesから再度ダウンロードしてください
- Codexの利用料は、利用者がCodex CLIでログインしたアカウントに発生します

## 確認項目

- TypeScript型チェック
- ESLint
- キャプチャBridgeプロトコル検証
- Androidコンパニオンのdebugビルド
- Electron ForgeによるWindows x64パッケージ・ZIP生成
- ZIP内の`PixelCodex.exe`と主要リソースの存在確認
