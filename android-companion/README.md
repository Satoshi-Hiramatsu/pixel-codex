# Pixel Codex Android Companion

AndroidからPixel Codexの状態を確認し、新規・追加のテキスト指示を送る最小Composeアプリです。iOSは対象外です。

## 現在できること

- RelayへWebSocket接続
- Host IDで接続先PCを指定
- PCのワークスペース、統括責任者、状態、最新メッセージを表示
- Androidから`instruction.submit`を送信
- PCでの即時開始／Queue登録／拒否／失敗を表示
- 承認待ちと質問待ちを表示（操作はPC）

QRペアリング、端末鍵、FCM通知は未実装です。現在のRelay URL内のトークン方式はローカル結合試験専用で、本番用認証には使用しません。

## 開発用Relayでの確認

### USB実機（推奨・ターミナル操作不要）

1. Pixel 9をUSB接続し、USBデバッグを許可する。
2. PC版Pixel Codexを`npm start`で起動する。
3. PC版で作業フォルダを選び、Codexへ接続する。
4. 通信室を開き、`USB実機テストを開始`を押す。
5. PC版がRelay起動、ADB転送、Androidアプリ起動、接続情報の設定を自動実行する。
6. Pixel 9に`PCオンライン`が表示されたら指示を入力して送信する。

USBを抜き差しした場合は、通信室のボタンをもう一度押してください。

### Relayを単独起動する場合

PC側で16文字以上の一時トークンを設定してRelayを起動します。

```powershell
$env:PIXEL_CODEX_RELAY_TOKEN='replace-with-a-long-random-token'
npm.cmd run relay:dev
```

Pixel Codexの通信室には次を設定します。

```text
ws://127.0.0.1:8787/relay?token=replace-with-a-long-random-token
```

Android Emulatorでは次を入力します。

```text
ws://10.0.2.2:8787/relay?token=replace-with-a-long-random-token
```

Host IDはPCの通信室に表示されます。`ws://`はdebugビルドとループバック相当の開発接続だけで使い、実運用では必ず`wss://`を使います。

## ビルド要件

- Android StudioとJDK 17
- Android SDK 36
- Gradle 9.1以上

Android Studioで`android-companion`を開き、Gradle Sync後にビルドしてください。

PowerShellからはAndroid Studio付属JDKを`JAVA_HOME`へ設定したうえで実行できます。

```powershell
.\gradlew.bat :app:assembleDebug
```

生成先は`app/build/outputs/apk/debug/app-debug.apk`です。
