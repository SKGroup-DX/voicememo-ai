\# ボイスメモ要約 - プロジェクト概要



\## 概要

iOS PWA。iPhone純正「ボイスメモ」で録音・文字起こししたテキストを貼り付け → Gemini AIで要約（1on1／複数人会議を自動判定してフォーマットを出し分け）し、ログイン名ごとに履歴として保存。アプリ内での録音・音声の文字起こしは行わない。

URL: https://skgroup-dx.github.io/voicememo-ai/



\## 技術スタック

\- フロント: GitHub Pages上の単一HTMLファイル（index.html。ReactをReact.createElementで直接書いている）

\- バックエンド: Google Apps Script (GAS)。コードは gas/Code.gs と gas/appsscript.json に置き、Apps Scriptエディタへ貼り付けてデプロイする

\- AI: Gemini API (gemini-3.5-flash/v1)。APIキーではなくスクリプト所有者のOAuthトークンで呼ぶ（無料枠）

\- データ保存: Google Sheets（recordsシート）



\## 必須ルール(標準スタック)

\- iOS Safari互換性・PWA対応を最優先の設計制約とする

\- CORSはGAS側をtext/plainコンテントタイプで受けて回避する

\- 日時はローカル時刻で組み立てる(UTCは使わない)

\- フォントは IBM Plex Sans JP / Noto Sans JP

\- このリポジトリは公開されている。合言葉・プロジェクトID・APIキー等の秘密はコードやこのファイルに書かず、GASのスクリプトプロパティ（APP_PASSCODE、GCP_PROJECT_ID）にだけ置く

\- アプリからGASへの呼び出しはすべてPOSTで、本文に合言葉（key）を入れる。GASは合言葉が違えば authError を返す



\## 直近の変更履歴

\- 社内共通の合言葉で記録を保護（合言葉なしでは履歴を読めない）

\- 不要になった音声・分割録音の仕組みを削除し、GASコードをリポジトリで管理

\- 履歴一覧から文字起こし本文を外して軽量化、検索をGAS側で全件に対して行う



\## 変更時のお願い

\- 複雑な変更は実装前にオプションA/B形式で提案し、承認を得てから実装する

\- 回答は簡潔に、前置きは省略する


\## 修正時の作業手順

\- 起動 → 状況把握 → 修正依頼 → 差分確認 → ローカルテスト → コミット → push → 実機確認、の順で進める

\- git commitは自動許可(都度確認は不要)

\- git pushは必ず都度確認を取ってから実行する

\- 複雑な変更は実装前にオプションA/B形式で提案し、承認を得てから進める
