\# VoiceMemo AI - プロジェクト概要



\## 概要

iOS PWA。iPhone純正「ボイスメモ」で録音・文字起こししたテキストを貼り付け → Gemini AIで要約（1on1／複数人会議を自動判定してフォーマットを出し分け）し、ログイン名ごとに履歴として保存。アプリ内での録音・音声の文字起こしは行わない。

URL: https://skgroup-dx.github.io/voicememo-ai/



\## 技術スタック

\- フロント: GitHub Pages上の単一HTMLファイル(バニラJS or React Babel standalone)

\- バックエンド: Google Apps Script (GAS)

\- AI: Gemini API (gemini-3.5-flash/v1)

\- データ保存: Google Sheets / Drive



\## 必須ルール(標準スタック)

\- iOS Safari互換性・PWA対応を最優先の設計制約とする

\- CORSはGAS側をtext/plainコンテントタイプで受けて回避する

\- 日時はローカル時刻で組み立てる(UTCは使わない)

\- 管理者PINは 3150(他アプリと共通)

\- フォントは IBM Plex Sans JP / Noto Sans JP



\## 直近の変更履歴

\- 主要バグ修正、コード全面再構築

\- 即時保存ロジック実装

\- Gemini API 503エラー時のリトライ処理実装



\## 変更時のお願い

\- 複雑な変更は実装前にオプションA/B形式で提案し、承認を得てから実装する

\- 回答は簡潔に、前置きは省略する


\## 修正時の作業手順

\- 起動 → 状況把握 → 修正依頼 → 差分確認 → ローカルテスト → コミット → push → 実機確認、の順で進める

\- git commitは自動許可(都度確認は不要)

\- git pushは必ず都度確認を取ってから実行する

\- 複雑な変更は実装前にオプションA/B形式で提案し、承認を得てから進める

