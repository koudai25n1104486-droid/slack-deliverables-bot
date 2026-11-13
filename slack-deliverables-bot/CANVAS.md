# 1枚のSlack Canvasへ毎週追記する方法

**チャンネル投稿をメインにする今回の構成は [BOTH.md](BOTH.md) を参照してください。** この文書の作成手順・Canvas IDの準備は併用できますが、出力モードは `canvas` ではなく `both` にします。以下の本文はCanvas単独出力の説明です。

## 動作

```text
制作物一覧（同じチャンネルのCanvas）
  今週の制作物：11/09〜11/15
    イラスト
      ・作品A.png → Slackの元投稿
    動画
      ・映像B.mp4 → Slackの元投稿
  今週の制作物：11/16〜11/22
    イラスト
      ・作品C.png → Slackの元投稿
    制作物
      ・未分類.pdf → Slackの元投稿
```

- `#制作物-イラスト` 等で分類し、週次実行ごとに **末尾に追加**します。既存内容の置換・削除は行いません。
- 毎週別のCanvasを作らず、設定した同じCanvas IDを使います。
- ファイル名と元投稿リンクだけを掲載します。画像本体の取得・保存・再アップロードは行いません。
- Canvasモードでは親メッセージ・スレッド返信・ピン留めを作りません。チャンネルのCanvasタブから開きます。
- Slackの設定によって、Canvas更新の通知がチャンネルに表示されることがあります。
- 運用開始後の各週を追加する仕組みで、過去のまとめや全履歴の自動移行は行いません。

## 1. 更新版を配置

ボットを停止し、コードを更新します。既存の `.env` と `.state` は引き継ぎます。

```bash
npm ci --ignore-scripts
```

依存パッケージの追加・変更はありません。

## 2. Slack権限を追加

アプリ管理画面の **OAuth & Permissions → Bot Token Scopes** に **`canvases:write`** を追加し、再インストールします。ボットを対象チャンネルに追加してください。

Canvas専用であれば、必要なBotスコープは `channels:history`（プライベートの収集元なら `groups:history`）と `canvases:write` です。Socket Modeの `connections:write` は引き続きアプリレベルトークンに必要です。

このスコープ自体はCanvasの作成・編集・削除を許可する広い権限ですが、実装する操作は明示的なチャンネルCanvasの作成と末尾追記のみです。学校の審査に追加してください。
Canvas専用アプリ作成用のマニフェストは `slack-manifest-canvas.json` です。既存アプリで他の機能を使う場合は必要な権限を維持してください。

## 3. Canvasを用意

`.env` で作成先チャンネルと実行許可を設定します。1チャンネルで完結させる場合、3つのチャンネルIDは同じ値です。

```dotenv
SLACK_SOURCE_CHANNEL_ID=C実際のチャンネルID
SLACK_TEST_CHANNEL_ID=C実際のチャンネルID
SLACK_OUTPUT_CHANNEL_ID=C実際のチャンネルID
ALLOW_SLACK_POST=true
ENABLE_WEEKLY=false
OUTPUT_MODE=canvas
```

次を **一度** 実行します。

```bash
npm run canvas:setup
```

対象チャンネルのCanvas「制作物一覧」を作成し、次のようにIDを表示します。

```json
{"status":"canvas_created","canvasId":"F0123456789"}
```

表示されたIDを `.env` に設定します。

```dotenv
SLACK_CANVAS_ID=F実際のCanvasID
SLACK_TEST_CANVAS_ID=F実際のCanvasID
```

練習中は両方を同じIDにして、1枚で試せます。本番では別の練習用Canvasを使うこともできます。テスト用IDが空の場合、本番Canvasへ自動で書き込むことはありません。

### 既にチャンネルCanvasがある場合

`CANVAS_ALREADY_EXISTS` が出たら、既存Canvasを上書きせず停止した状態です。そのCanvasを使う場合は、SlackでCanvasを開き、リンクをコピーしてリンク内の **Fから始まるCanvas ID** を確認し、上記2項目に設定します。ボットにそのCanvasの編集権限が必要です。無関係なCanvasのIDを設定しないでください。

Canvasの利用可否・作成・編集権限は学校のSlackの設定に従います。`no_permission`、`canvas_disabled_user_team` 等のエラーは管理者と確認してください。

## 4. すぐにテスト追記

架空の制作物をチャンネル本体へ投稿します。

```text
#制作物-イラスト
Canvasのテストです。
［画像を添付］
```

読み取り確認と追記を実行します。

```bash
npm run preview
npm run post:test
```

Canvasの末尾に「【試作品】今週の制作物」と分類別の一覧が追加されます。同じ日にもう一度試す場合は次を使います。

```bash
npm run post:test -- --run-id=2
```

さらに試す場合は3、4と番号を変えます。古いテストの部分は残ります。不要なテスト部分はSlack上で担当者が手動で削除できます。

以前のスレッド投稿の実行記録とは区別しているため、同日のスレッドテスト済み記録が最初のCanvas追記を妨げることはありません。

## 5. 毎週の追記を有効化

```dotenv
ALLOW_SLACK_POST=true
ENABLE_WEEKLY=true
OUTPUT_MODE=canvas
```

```bash
npm start
```

初期設定では毎週月曜9時以降（日本時間）、前週月曜0時〜今週月曜0時を対象に追記します。投稿曜日・時刻はSCHEDULE.mdのメンション管理で変更できます。週次は `SLACK_CANVAS_ID`、手動テストは `SLACK_TEST_CANVAS_ID` を使います。
常駐環境が停止・スリープ中は実行できません。長期停止中の全期間をまとめてさかのぼる処理はありません。対象0件の週は追記しません。

## 障害と保存情報

- 1週間分を1回の `canvases.edit` の `insert_at_end` 操作で追加します。既存Canvas本文の読み取り・置換・削除はしません。
- `.state/ledger.json` にはCanvas ID・対象期間・投稿先の設定ID・状態だけを記録します。制作物本文・ファイル名・Canvas本文はディスクやログに保存しません。
- 同じCanvas・対象期間・テスト番号の重複を抑止します。番号付き追記は手動テスト専用です。
- 通信結果が不明な場合は、成功している可能性があるため自動再送しません。Canvas内を確認してから担当者が該当の実行記録を整理してください。
- 権限不足等で失敗した場合も実行記録は残ります。修正後は、テストなら別番号、週次ならCanvas側の状態を確認したうえで該当レコードを整理して再実行してください。
- Canvasの容量上限に達した場合は停止します。年別に別Canvasへ切り替えるなどの運用が必要です。過去分を自動削除しません。
- 元投稿の削除・編集は追記済みのCanvasに同期しません。Slackの保存設定により、リンク先が閲覧できなくなることがあります。
- Canvasの閲覧・編集範囲は学校が確認してください。既存の独立したCanvasを指定した場合、元チャンネルと同じ権限だと仮定しないでください。

## スレッド方式へ戻す

`OUTPUT_MODE=thread` にして再起動します。Canvasの過去の追記は残ります。Canvas用とスレッド用は実行記録を分けるため、切り替えた週に両方へ出力される場合があります。

## 公式資料

- [Canvasの末尾への追記](https://docs.slack.dev/reference/methods/canvases.edit/)
- [チャンネルCanvasの作成](https://docs.slack.dev/reference/methods/conversations.canvases.create/)
- [Canvas権限](https://docs.slack.dev/reference/scopes/canvases.write/)
- [Canvasの利用プラン・管理設定](https://slack.com/help/articles/33536064287891-Manage-canvas-settings-in-Slack)
