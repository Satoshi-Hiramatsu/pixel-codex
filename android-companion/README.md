# Pixel Codex Android Companion

AndroidからPixel Codexの状態を確認し、指示・承認・回答を送るComposeアプリです。iOSは対象外です。

バージョン **0.2.1**（versionCode 3）。

## 画面

上部のタブで2つの画面を切り替えます。

| タブ | 内容 |
| --- | --- |
| Codex | PCの状態、新規・追加指示、承認カード、質問カード |
| 通信設定 | ペアリング（QR／コード）、接続・切断・再接続、PCの探し直し、手動設定 |

## 現在できること

- QRコードまたは6桁コードによるペアリング（ケーブル不要）
- RelayへWebSocket接続、切断、前回設定での再接続
- PCのIPが変わったときのLAN内自動再検出
- PCのワークスペース、統括責任者、状態、最新メッセージを表示
- `instruction.submit`で新規・追加指示を送信
- PCでの即時開始／Queue登録／拒否／失敗を表示
- 承認の可否を`approval.respond`で返答（PC側で許可した場合のみ）
- 質問への回答を`question.respond`で返答（同上）

端末鍵、FCM通知、外部Relay経由の実運用は未実装です。現在のRelay URL内のトークン方式はローカル結合試験専用で、本番用認証には使用しません。

## 権限

| 権限 | 用途 |
| --- | --- |
| `INTERNET` | RelayへのWebSocket接続、ペアリングのHTTP通信 |
| `CAMERA` | 接続設定QRの読み取りのみ。初回スキャン時に確認されます |

カメラを使わない場合は、通信設定タブでアドレスとコードを手入力できます。

## つなぎ方

### 完全ワイヤレス（推奨・ケーブル不要）

APKさえ入っていれば、以降ケーブルは一切使いません。

1. PCとPixel 9を同じネットワークへ接続する。
2. PC版の通信室で`ケーブルなしでペアリング`を押す。PCのアドレス・6桁コード・QRが表示される。
3. Pixel 9のアプリで`通信設定`タブを開き、`QRで読み取る`でQRを読む（アドレスとコードの手入力も可）。
4. `PCオンライン`になれば成功。PC側の表示も`ペアリングしました`に変わる。
5. Androidから新規指示を送り、PC版の通信ログとCodexの開始を確認する。
6. Codexの処理中にもう一度指示を送り、待ち行列へ登録されることを確認する。

コードは3分で失効し、5回まちがえるとその場で受付を終了します。

2回目以降はアプリを起動するだけで自動的に再接続します。Relayのポート（既定57170から順に探索）とトークンはPC側に保存されるため、PCを再起動してもペアリングは有効なままです。

### PCのIPアドレスが変わったとき

ノートPCなどでネットワークが変わっても、再ペアリングは不要です。トークンとHost IDは保存済みなので、いまPCがどこにいるかだけ分かれば復帰できます。

- **自動** … 保存先への接続に失敗すると、一度だけ黙って探索して復帰します。
- **手動** … `通信設定`タブの`PCを探し直す（IPが変わったとき）`を押します。

探索は`/health`が名乗るHost IDだけで判定し、**トークンは一切送りません**。見る範囲は次の2つの/24です。

1. 前回PCがいたサブネット（IPが振り直されただけならここで見つかります）
2. 端末自身のサブネット（PCが同じ側へ移ってきた場合）

端末とPCが別セグメントに置かれる構成（端末がWi-Fi、PCが有線など）でも復帰できます。両方が同時に未知のサブネットへ移った場合だけ、QRで再ペアリングしてください。

### USB実機（APK導入直後やトラブル時）

1. Pixel 9をUSB接続し、USBデバッグを許可する。
2. PC版Pixel Codexを`npm start`で起動する。
3. PC版で作業フォルダを選び、Codexへ接続する。
4. 通信室を開き、`USB実機テストを開始`を押す。
5. PC版がRelay起動、ADB転送、Androidアプリ起動、接続情報の設定を自動実行する。
6. Pixel 9に`PCオンライン`が表示されたら指示を入力して送信する。

USBを抜き差しした場合は、通信室のボタンをもう一度押してください。

### ファイアウォール

Windows Defender Firewallが確認を表示した場合は、プライベートネットワークだけを許可してください。すでに`アクセスを許可しない`を押してしまった場合はブロック規則が残り、**以後の接続がすべて10秒でタイムアウトします**。Windowsではブロック規則が許可規則より優先されるため、削除してから許可規則を追加します（管理者権限のPowerShell）。

```powershell
Get-NetFirewallApplicationFilter |
  Where-Object { $_.Program -like '*pixel-codex*electron.exe' } |
  Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName 'Pixel Codex Dev Relay (LAN)' `
  -Direction Inbound -Action Allow -Protocol TCP `
  -Program 'C:\path\to\pixel-codex\node_modules\electron\dist\electron.exe' `
  -Profile Private,Public -RemoteAddress LocalSubnet
```

### Wi-Fi実機（初回設定だけUSB・従来方式）

1. PCとPixel 9を同じWi-Fiへ接続する。
2. 初回設定を渡すためPixel 9をUSB接続したまま、通信室の`Wi-Fi実機テストを開始`を押す。
3. Pixel 9に`PCオンライン`が表示されたらUSBケーブルを抜く。

このモードはプライベートIPv4アドレスと平文の`ws://`を使います。PC版を終了するとRelayも停止します。公衆Wi-Fiや本番運用では使用しません。

## スマートフォンからの承認・回答

PC版の通信室にある`承認の可否と質問への回答をスマートフォンから行う`は**既定でオフ**です。オフの間、端末には「承認待ちがあります」とだけ表示され、操作はできません。

オンにすると`Codex`タブに次が出ます。

- **承認カード** … 見出し、リスク、実行するコマンド、作業場所、`拒否`／`承認する`
- **質問カード** … 質問ごとの回答欄と候補、全問そろってから`回答を送る`

PC側の扱い：

- `機微情報を隠す`が有効な間は、パスとトークンを伏せて送ります
- 秘密の入力（`isSecret`）を含む質問は端末へ送らず、端末からの回答も拒否します
- PCで先に処理済みの承認・質問に端末から答えた場合は拒否し、理由を端末へ返します
- 受け付けるのは`accept`／`decline`のみ。回答は12件・1000文字までです

## プロトコル

端末から送るのは次の3種類だけです。それ以外の型はPC側の`RemoteCommandGuard`が拒否します。

| 型 | 用途 |
| --- | --- |
| `instruction.submit` | 新規・追加指示（4000文字まで） |
| `approval.respond` | 承認の可否 |
| `question.respond` | 質問への回答 |

すべてのメッセージで、送信先PCの一致、`messageId`の重複、送信時刻のずれ（±2分）を検証します。

QRの中身は次のJSONです。

```json
{"v":1,"t":"lan","h":"192.168.10.39","p":57170,"c":"418052"}
{"v":1,"t":"url","u":"wss://relay.example.com/relay?token=...","i":"<hostId>"}
```

`lan`はペアリングコードと引き換えにトークンを受け取ります。`url`はURLに認証情報が入っているのでそのまま接続します。ループバックアドレスを指すQRは端末側で拒否します（端末から見ると端末自身を指すため）。

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
