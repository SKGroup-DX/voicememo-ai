# ボイスメモ要約

iPhone純正「ボイスメモ」で録音・文字起こししたテキストを貼り付けると、AI（Gemini）が1on1／会議を自動で判定して要約し、ログイン名ごとに履歴として保存するアプリ（iOS向けPWA）。

アプリ：https://skgroup-dx.github.io/voicememo-ai/

## 構成

| 部分 | 中身 |
|---|---|
| 画面 | `index.html`（1ファイル。ReactをReact.createElementで直接書いている）、`sw.js`（オフライン用のキャッシュ）、`manifest.json`、アイコン。GitHub Pagesで公開 |
| サーバー | `gas/Code.gs`・`gas/appsscript.json`（Google Apps Script。スプレッドシートに紐づけてWebアプリとして公開） |
| 保存先 | スプレッドシートの `records` シート（1件1行、9列） |
| AI | Gemini API（無料枠）。APIキーではなく、スクリプト所有者のGoogleログイン権限で呼ぶ |

### 流れ

1. アプリが記録の番号（UUID）を決め、「受け付け」（`submitTranscript`）と「要約開始」（`processRecord`）を同時に送る
2. GASは文字起こしを保存し、Geminiで要約して同じ行に書き込む
3. その場で要約できなかった記録は、1分おきの定期実行（`runPendingJobs`）が要約する
4. アプリは5秒おきに状況を確認し、終わったら「要約ができました」を表示する

## 秘密の情報について

このリポジトリは公開されています。合言葉やプロジェクトIDはコードに書かず、Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」に保存します。

| プロパティ | 内容 |
|---|---|
| `APP_PASSCODE` | 社内共通の合言葉（必須。未設定だと誰も使えない）。12文字以上を推奨 |
| `GCP_PROJECT_ID` | Geminiの利用枠を付けるGoogle CloudのプロジェクトID（必須） |
| `GEMINI_MODEL` | 使うモデル（任意。未設定なら `gemini-3.5-flash-lite`） |
| `TRANSCRIPT_RETENTION_DAYS` | 文字起こしの本文を残す日数（任意。未設定なら90日、0なら消さない）。過ぎた記録は要約だけ残る |
| `NO_FAST_CONFIG_<モデル名>` | GASが自動で書く（そのモデルが高速化の設定を受け付けないことの記録）。消さない |

## GASの更新手順

1. `gas/Code.gs` の中身を、Apps Scriptエディタの「コード.gs」に全文貼り付けて保存する
2. 「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」→「デプロイ」（URLは変わらない）
3. デプロイ直後の1〜2分は、Google側で404になることがある（アプリは自動でやり直す）

初めて設定するとき・定期実行を作り直すときは、エディタで `setupTriggers` を1回実行する（`runPendingJobs` 1分おき、`warmup` 5分おき、`purgeOldTranscripts` 毎日3時ごろ）。

### 確認用の関数（エディタから実行）

| 関数 | 用途 |
|---|---|
| `checkPasscodeSetting` | 合言葉が設定されているか（値は表示しない） |
| `testGeminiModel` | 今のモデルでGeminiを呼べるか |
| `listGeminiModels` | 使えるモデルの一覧（軽量版を先に表示） |

## 画面の更新手順

`index.html` などを変更して `main` にpushすると、GitHub Pagesに反映される。利用者の画面には「新しいバージョンがあります［更新する］」が出る（`sw.js` の `CACHE_NAME` を変えたとき）。
