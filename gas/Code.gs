// ================================================================
// ボイスメモ要約 - GAS バックエンド
// ================================================================
// このファイルはApps Scriptエディタの「コード.gs」に貼り付けて使う。
// 合言葉（APP_PASSCODE）とGoogle CloudのプロジェクトID（GCP_PROJECT_ID）は
// コードには書かず、Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」に
// 保存する（このリポジトリは公開されているため）。

const SHEET_RECORDS    = "records";
const GEMINI_MODEL     = "gemini-3.5-flash";
const GEMINI_API_BASE  = "https://generativelanguage.googleapis.com/v1/models/";

// recordsシートの列定義
const COL = { ID:1, DATE:2, MEMBER:3, INTERVIEWEE:4, STATUS:5, SECTIONS:6, TRANSCRIPT:7, PROCESS_ERROR:8, PROCESSING_STARTED_AT:9 };
const NUM_COLS    = 9;
const HEADERS     = ["ID", "日時", "名前", "相手", "状態", "要約", "文字起こし", "エラー", "処理開始時刻"];
// 状態列の値: "queued"(要約待ち) | "processing"(要約中) | "done"(完了) | "error"(失敗)

// 音声を扱っていた頃の古い列構成（16列）。migrateRecordsSheetでの移行にだけ使う。
const OLD_COL = { ID:1, DATE:2, MEMBER:4, INTERVIEWEE:5, SECTIONS:8, STATUS:11, PROCESS_ERROR:12, PROCESSING_STARTED_AT:15, TRANSCRIPT:16 };
const OLD_NUM_COLS = 16;
const OLD_SHEET_NAMES = ["members", "chunks"]; // 移行時に削除する、使っていないシート

const STALE_PROCESSING_MINUTES = 10; // これ以上"processing"のままの行は実行が異常終了したとみなし再投入する
const HEADER_ROW  = 1;
const MAX_TRANSCRIPT_CHARS = 30000;  // アプリ側の上限と合わせる
const HISTORY_MAX_LIMIT = 50;
// 合言葉を間違えた時に応答を遅らせ、総当たりで合言葉を探られにくくする
const AUTH_FAIL_WAIT_MS = 2000;

// ================================================================
// エントリーポイント
// ================================================================
// アプリからの呼び出しはすべてPOST（本文に合言葉を入れる）。合言葉をURLに
// 載せないよう、GETでは何も返さない。
function doGet(e) {
  return jsonResponse({ success: false, error: "このURLはアプリ専用です" });
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!isAuthorized(body.key)) {
      Utilities.sleep(AUTH_FAIL_WAIT_MS);
      return jsonResponse({ success: false, authError: true, error: "合言葉が正しくありません" });
    }
    const action = body.action || "";
    let result = {};

    switch (action) {
      case "checkPasscode":
        result = { success: true }; break;
      case "getHistory":
        result = getHistory(body); break;
      case "getRecordStatus":
        result = getRecordStatus(body); break;
      case "getTranscript":
        result = getTranscript(body); break;
      case "submitTranscript":
        result = submitTranscript(body); break;
      case "processRecord":
        result = processRecord(body); break;
      case "retryRecord":
        result = retryRecord(body); break;
      case "updateRecord":
        // アプリから変えられるのは要約の中身だけ（状態などは書き換えさせない）
        result = updateRecord({ id: body.id, sections: body.sections }); break;
      case "deleteRecord":
        result = deleteRecord(body); break;
      default:
        result = { success: false, error: "Unknown action: " + action };
    }

    return jsonResponse(result);
  } catch (err) {
    console.error("[doPost] error:", err.message, err.stack);
    return jsonResponse({ success: false, error: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 合言葉はスクリプトプロパティ APP_PASSCODE と照合する。未設定のときは
// 誰も使えないようにする（設定し忘れて誰でも読める状態にならないように）。
function isAuthorized(key) {
  const expected = String(PropertiesService.getScriptProperties().getProperty("APP_PASSCODE") || "").trim();
  if (!expected) {
    console.error("[auth] APP_PASSCODE がスクリプトプロパティに設定されていません");
    return false;
  }
  return typeof key === "string" && key.trim() === expected;
}

// ================================================================
// 履歴取得（一覧用。文字起こし本文は含めず軽くする）
// ================================================================
// q: キーワード（空白区切りで複数指定するとすべてを含むものだけ）。相手・要約・
//    文字起こしのどれかに含まれていれば該当とする。
// type: "1on1" | "group"（指定なしはすべて）
function getHistory(body) {
  const member = String(body.member || "");
  if (!member) return { success: false, error: "member required" };
  const limit  = Math.min(parseInt(body.limit) || 20, HISTORY_MAX_LIMIT);
  const offset = Math.max(parseInt(body.offset) || 0, 0);
  const type   = String(body.type || "");
  const terms  = String(body.q || "").toLowerCase().split(/[\s　]+/).filter(Boolean);

  const rows = readAllRows();
  const matched = [];
  for (let i = rows.length - 1; i >= 0; i--) { // 新しい順
    const row = rows[i];
    if (String(row[COL.MEMBER - 1] || "") !== member) continue;
    const rec = rowToRecord(row);
    if (!rec) continue;
    if (type && !(rec.sections && rec.sections.meetingType === type)) continue;
    if (terms.length) {
      const text = searchableText(rec, row);
      if (!terms.every(t => text.indexOf(t) !== -1)) continue;
    }
    matched.push(rec);
  }

  const total = matched.length;
  return {
    success: true,
    records: matched.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total
  };
}

function searchableText(rec, row) {
  const parts = [rec.interviewee, rowTranscript(row)];
  const secs = (rec.sections && rec.sections.sections) || [];
  secs.forEach(s => {
    parts.push(s.label || "");
    (s.items || []).forEach(i => parts.push(String(i)));
  });
  return parts.join("\n").toLowerCase();
}

// ================================================================
// 文字起こし本文の取得（要約画面で「文字起こし」を開いた時だけ呼ばれる）
// ================================================================
function getTranscript(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  const sheet = recordsSheet();
  const row = findRecordRowById(sheet, id);
  if (row < 0) return { success: false, error: "Record not found: " + id };
  const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
  return { success: true, transcript: rowTranscript(values) };
}

function rowTranscript(row) {
  return String(row[COL.TRANSCRIPT - 1] || "");
}

// ================================================================
// 処理状況の取得（ポーリング用・軽量）
// ================================================================
function getRecordStatus(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { found: false, error: "id required" };

  const sheet = recordsSheet();
  const targetRow = findRecordRowById(sheet, id);
  if (targetRow < 0) return { found: false };

  const values = sheet.getRange(targetRow, 1, 1, NUM_COLS).getValues()[0];
  return {
    found: true,
    status: String(values[COL.STATUS - 1] || ""),
    sections: stripTranscript(parseSections(values[COL.SECTIONS - 1])),
    error: String(values[COL.PROCESS_ERROR - 1] || "")
  };
}

// ================================================================
// 文字起こしの受け付け
// ================================================================
// アプリは文字起こしを保存（＝受け付け）した時点ですぐ利用者に返し、続けて
// processRecordを呼んで要約を始めてもらう。processRecordが届かなかった場合も、
// "queued"の記録は1分おきの定期実行（runPendingJobs）が要約する。
function submitTranscript(body) {
  const member      = String(body.member || "");
  const interviewee = String(body.interviewee || "");
  const transcript  = String(body.transcript || "").trim();

  if (!member) return { success: false, error: "member required" };
  if (!transcript) return { success: false, error: "文字起こしテキストがありません" };
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return { success: false, error: "文字数が上限（" + MAX_TRANSCRIPT_CHARS + "文字）を超えています" };
  }

  const sheet      = recordsSheet();
  const recordDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
  const newId      = Utilities.getUuid();

  withShortLock(() => {
    sheet.appendRow([
      newId,        // COL.ID
      recordDate,   // COL.DATE
      member,       // COL.MEMBER
      interviewee,  // COL.INTERVIEWEE
      "queued",     // COL.STATUS
      "",           // COL.SECTIONS: まだなし
      transcript,   // COL.TRANSCRIPT
      "",           // COL.PROCESS_ERROR
      ""            // COL.PROCESSING_STARTED_AT
    ]);
  });
  console.log("[submitTranscript] 受け付け完了 id:", newId);

  return { success: true, id: newId, status: "queued" };
}

// ================================================================
// 要約の処理の流れ（その場での要約と、1分おきの定期実行）
// ================================================================
// 1件の記録を要約するのは、つねに「受け付け済み（queued）の行をロックの中で
// processing に切り替えた処理」1つだけ。切り替えた時刻（処理開始時刻）を目印として
// 覚えておき、終わったときに目印が自分のものの場合だけ状態を書き換える。
// 以前は、その場での要約が失敗したときに状態を確かめずに queued に戻していたため、
// 定期実行が処理している最中の記録を別の定期実行がもう一度拾って二重に要約し、
// 先に完了した要約を後から「失敗」で上書きしてしまうことがあった。

// その場での要約（アプリが受け付け直後に呼ぶ）。アプリの待ち上限90秒に収める。
// 利用回数の上限（429）で10秒より長く待つよう言われたら、その場ではあきらめて
// 定期実行に任せる（待つ間もGeminiの呼び出しを重ねると、上限にかかり続けるため）。
const RETRY_POLICY_SYNC = { maxAttempts: 3, budgetMs: 60 * 1000, max429WaitSec: 10, serverErrorWaitSec: () => 2 };
// 定期実行での要約。GASの実行時間上限（6分）に収まるよう、1件あたり最大4分。
const RETRY_POLICY_BACKGROUND = { maxAttempts: 6, budgetMs: 4 * 60 * 1000, max429WaitSec: 60, serverErrorWaitSec: attempt => Math.min(attempt * 5, 20) };
// 1回の定期実行で新しい記録を拾い始めるのは、開始からこの時間まで
const RUN_PICKUP_LIMIT_MS = 60 * 1000;

function processRecord(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  const auth = getGeminiAuth();
  const job = claimQueuedRow_(id);
  if (!job) return { success: true, id, status: "skipped" };
  if (!job.transcript) {
    finishJob_(job, { error: "文字起こしテキストがありません" });
    return { success: true, id, status: "error" };
  }
  try {
    const t0 = Date.now();
    const sections = callGeminiSummarize(job.transcript, auth, RETRY_POLICY_SYNC);
    console.log("[processRecord] 要約にかかった時間:", ((Date.now() - t0) / 1000).toFixed(1), "秒 ／ 文字数:", job.transcript.length, "／ 種別:", sections.meetingType || "不明");
    finishJob_(job, { sections });
    return { success: true, id, status: "done", sections };
  } catch (e) {
    console.warn("[processRecord] その場での要約をあきらめ、定期実行に任せる id:", id, e.message);
    finishJob_(job, { requeue: true });
    return { success: true, id, status: "queued" };
  }
}

// 定期実行（setupTriggersで1分おきに設定）。受け付け済みの記録を1件ずつ要約する。
// 複数件たまっていても、拾い始めるのは開始から1分まで（長引いた分は次の回に回す）。
function runPendingJobs() {
  const startedAt = Date.now();
  let auth;
  try {
    auth = getGeminiAuth();
  } catch (e) {
    console.error("[runPendingJobs] 認証情報を用意できないため中断:", e.message);
    return;
  }
  while (Date.now() - startedAt < RUN_PICKUP_LIMIT_MS) {
    const job = claimQueuedRow_(null);
    if (!job) return;
    try {
      if (!job.transcript) throw new Error("文字起こしテキストがありません");
      console.log("[runPendingJobs] 要約開始 id:", job.id);
      const sections = callGeminiSummarize(job.transcript, auth, RETRY_POLICY_BACKGROUND);
      const result = finishJob_(job, { sections });
      console.log("[runPendingJobs] 完了 id:", job.id, "（" + result + "）");
    } catch (e) {
      const result = finishJob_(job, { error: e.message });
      console.error("[runPendingJobs] 失敗 id:", job.id, e.message, "（" + result + "）");
    }
  }
}

// queuedの行を1件選んでprocessingに切り替え、内容と目印を返す（なければnull）。
// idを指定するとその行だけを対象にする。
function claimQueuedRow_(id) {
  const lock = LockService.getScriptLock();
  let gotLock = false;
  try {
    gotLock = lock.tryLock(10000);
  } catch (e) {}
  if (!gotLock) return null; // 取れなければ次の機会（定期実行）に任せる
  try {
    const sheet = recordsSheet();
    let row = -1;
    let values = null;
    if (id) {
      row = findRecordRowById(sheet, id);
      if (row >= 0) values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
    } else {
      const rows = readAllRows();
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][COL.STATUS - 1] || "") === "queued") {
          row = HEADER_ROW + 1 + i;
          values = rows[i];
          break;
        }
      }
    }
    if (row < 0 || String(values[COL.STATUS - 1] || "") !== "queued") return null;
    sheet.getRange(row, COL.STATUS).setValue("processing");
    const startedCell = sheet.getRange(row, COL.PROCESSING_STARTED_AT);
    startedCell.setValue(new Date());
    return {
      id: String(values[COL.ID - 1]),
      transcript: rowTranscript(values),
      // シートに入った値を読み直して目印にする（書いた値と読み直した値の微妙な違いで
      // 自分の目印を見失わないように）
      token: toMillis_(startedCell.getValue())
    };
  } finally {
    lock.releaseLock();
  }
}

// 要約の結果を書き込む。outcome は { sections } | { requeue: true } | { error: "..." }。
// 要約できた場合は、まだ完了になっていなければ（二重に処理された場合も）書き込む。
// 戻す・失敗にするのは、その行を今も自分が処理している場合だけ。
function finishJob_(job, outcome) {
  return withShortLock(() => {
    const sheet = recordsSheet();
    const row = findRecordRowById(sheet, job.id);
    if (row < 0) return "削除済み";
    const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
    const status = String(values[COL.STATUS - 1] || "");
    if (outcome.sections) {
      if (status === "done") return "完了済みのため書き込まず";
      sheet.getRange(row, COL.SECTIONS).setValue(JSON.stringify(stripTranscript(outcome.sections)));
      sheet.getRange(row, COL.STATUS).setValue("done");
      sheet.getRange(row, COL.PROCESS_ERROR).setValue("");
      return "完了";
    }
    const mine = status === "processing" && Math.abs(toMillis_(values[COL.PROCESSING_STARTED_AT - 1]) - job.token) < 1000;
    if (!mine) return "他の処理が担当中のため書き込まず";
    if (outcome.requeue) {
      sheet.getRange(row, COL.STATUS).setValue("queued");
      return "要約待ちに戻した";
    }
    sheet.getRange(row, COL.STATUS).setValue("error");
    sheet.getRange(row, COL.PROCESS_ERROR).setValue(outcome.error || "不明なエラー");
    return "失敗として記録";
  });
}

function toMillis_(v) {
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

// ================================================================
// 処理の再試行（保存済みの文字起こしをそのまま使い直す）
// ================================================================
// 失敗した記録だけを要約待ちに戻す（処理中・完了の記録には何もしない）。
function retryRecord(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  return withShortLock(() => {
    const sheet = recordsSheet();
    const row = findRecordRowById(sheet, id);
    if (row < 0) return { success: false, error: "Record not found: " + id };
    const status = String(sheet.getRange(row, COL.STATUS).getValue() || "");
    if (status !== "error") return { success: true, status };
    sheet.getRange(row, COL.STATUS).setValue("queued");
    sheet.getRange(row, COL.PROCESS_ERROR).setValue("");
    console.log("[retryRecord] 再受け付け完了 id:", id);
    return { success: true, status: "queued" };
  });
}

// 対話的な操作向けの短時間ロック。数百ms〜数秒で終わる想定なので、ロックが
// 取れなくても長く待たせず、そのまま処理を続行する（応答性を優先）。
function withShortLock(fn) {
  const lock = LockService.getScriptLock();
  let gotLock = false;
  try {
    gotLock = lock.tryLock(5000);
  } catch (e) {}
  try {
    return fn();
  } finally {
    if (gotLock) lock.releaseLock();
  }
}

// ================================================================
// Gemini API 呼び出し共通ヘルパー
// ================================================================
// 429 は「短時間に使える回数の上限」。Geminiが返す「◯秒後に再開できる」
// (RetryInfo) に従って待つ。待たずに呼び直しても上限にかかり続けるだけのため。
// 500/502/503/504 は一時的な混雑とみなし、少し待ってやり直す。
const RETRYABLE_SERVER_CODES = [500, 502, 503, 504];
// HTTPステータスは200（正常応答）でも、finishReasonが不安定でテキストが
// 返らないことがある。MALFORMED_RESPONSEは同じ入力でも再試行すると
// 直ることがあるため、混雑と同様にやり直す。
const RETRYABLE_FINISH_REASONS = ["MALFORMED_RESPONSE"];
const DEFAULT_429_WAIT_SEC = 15;

function fetchGeminiWithRetry(url, payload, label, auth, policy) {
  const p = policy || RETRY_POLICY_BACKGROUND;
  const deadline = Date.now() + p.budgetMs;
  let resText;
  for (let attempt = 1; ; attempt++) {
    const res = UrlFetchApp.fetch(url, makeOptions(payload, auth));
    const resCode = res.getResponseCode();
    resText = res.getContentText();
    console.log("[" + label + " API] attempt:", attempt, "status:", resCode);

    let waitSec = 0;
    let busyMessage = "";
    if (resCode === 429) {
      const info = parseRateLimit_(resText);
      console.warn("[" + label + " API] 429の詳細:", info.message);
      waitSec = info.retryDelaySec || DEFAULT_429_WAIT_SEC;
      busyMessage = "AIの利用回数が上限に達しています（無料枠）。少し時間をおいて再試行してください。";
      if (waitSec > p.max429WaitSec) {
        throw new Error(busyMessage + "（再開まで約" + Math.ceil(waitSec) + "秒）");
      }
    } else if (RETRYABLE_SERVER_CODES.indexOf(resCode) !== -1 || isRetryableFinish_(resCode, resText)) {
      waitSec = p.serverErrorWaitSec(attempt);
      busyMessage = "AIが混み合っています（" + (resCode === 200 ? "応答の形式エラー" : "HTTP " + resCode) + "）。少し時間をおいて再試行してください。";
    } else {
      return resText;
    }

    if (attempt >= p.maxAttempts || Date.now() + waitSec * 1000 > deadline) {
      throw new Error(busyMessage);
    }
    console.log("[" + label + " API] " + waitSec + "秒後にやり直し");
    Utilities.sleep(waitSec * 1000);
  }
}

function isRetryableFinish_(resCode, resText) {
  if (resCode !== 200) return false;
  try {
    const data = JSON.parse(resText);
    const finishReason = data.candidates && data.candidates[0] && data.candidates[0].finishReason;
    return !!finishReason && RETRYABLE_FINISH_REASONS.indexOf(finishReason) !== -1;
  } catch (e) {
    // JSON解析失敗はここではやり直さず、extractGeminiText側のエラーメッセージに委ねる
    return false;
  }
}

// 429の応答から、上限の種類（メッセージ）と再開までの秒数を取り出す
function parseRateLimit_(resText) {
  try {
    let data = JSON.parse(resText);
    if (Array.isArray(data)) data = data[0];
    const err = (data && data.error) || {};
    const retryInfo = (err.details || []).filter(d => String(d["@type"] || "").indexOf("RetryInfo") !== -1)[0];
    const sec = retryInfo ? parseFloat(String(retryInfo.retryDelay || "")) : NaN;
    return { message: String(err.message || "").slice(0, 400), retryDelaySec: isFinite(sec) ? Math.ceil(sec) : 0 };
  } catch (e) {
    return { message: String(resText || "").slice(0, 400), retryDelaySec: 0 };
  }
}

function extractGeminiText(resText, label) {
  let data;
  try {
    data = JSON.parse(resText);
  } catch (e) {
    throw new Error(label + ": レスポンスの解析に失敗しました（" + resText.slice(0, 200) + "）");
  }
  if (data.error) throw new Error(label + "APIエラー " + data.error.code + ": " + data.error.message);

  const candidate = data.candidates && data.candidates[0];
  if (!candidate) throw new Error(label + ": レスポンスにcandidatesがありません");

  const finishReason = candidate.finishReason || "不明";
  const text = candidate.content && candidate.content.parts && candidate.content.parts[0] && candidate.content.parts[0].text;
  if (!text) throw new Error(label + "失敗: finishReason=" + finishReason + " のためテキストが返されませんでした");

  return text;
}

// ================================================================
// Gemini 構造化要約
// ================================================================
// 要約を速く・安定させるための追加設定。
// thinkingLevel "low": モデルが答える前の内部推論（初期設定は中）を減らし、待ち時間を短くする。
//   要約や1on1/会議の判定程度なら品質への影響は小さい。
// responseMimeType JSON: 返答を必ずJSONにし、形式崩れによる失敗（＝後回し処理行き）を減らす。
// モデルやAPIの版によってはこれらの指定を受け付けず400になるため、その場合は
// 従来の設定で自動的にやり直す（要約自体は止めない）。
const SUMMARIZE_FAST_CONFIG = {
  responseMimeType: "application/json",
  thinkingConfig: { thinkingLevel: "low" }
};

function callGeminiSummarize(transcript, auth, policy) {
  const url = GEMINI_API_BASE + GEMINI_MODEL + ":generateContent";

  const prompt = getDefaultSystemPrompt() + "\n\n【文字起こし内容】\n" + transcript;
  const baseConfig = { temperature: 0.3, maxOutputTokens: 32768 };
  const buildPayload = config => ({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: config
  });

  let jsonText;
  try {
    const resText = fetchGeminiWithRetry(url, buildPayload(Object.assign({}, baseConfig, SUMMARIZE_FAST_CONFIG)), "要約", auth, policy);
    jsonText = extractGeminiText(resText, "要約");
  } catch (e) {
    if (e.message.indexOf("APIエラー 400") === -1) throw e;
    console.warn("[要約] 高速化の設定が受け付けられなかったため、従来の設定でやり直します:", e.message);
    const resText = fetchGeminiWithRetry(url, buildPayload(baseConfig), "要約", auth, policy);
    jsonText = extractGeminiText(resText, "要約");
  }

  // Geminiがmarkdownコードブロックで返す場合に対応
  jsonText = jsonText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    throw new Error("要約JSONのパース失敗: " + jsonText.slice(0, 200));
  }

  if (!parsed.sections) throw new Error("要約レスポンスにsectionsがありません: " + jsonText.slice(0, 200));

  // 文字起こしはTRANSCRIPT列にあるので、要約には入れない（一覧を軽くするため）
  return parsed;
}

// 実質的なメインの要約プロンプト。1on1（面談）と複数人の会議が同じ入り口から
// 来るため、Gemini自身に種別を判定させ、判定結果に応じて出力フォーマットを
// 出し分けさせる。「発言比率・傾聴スコア」等の分析は1on1向けの指標なので、
// 複数人会議と判定された場合はanalysisキー自体を出力させない
// （アプリ側は analysis が無ければ単に表示しないだけなので、これだけで両対応できる）。
function getDefaultSystemPrompt() {
  return `あなたは優秀な議事録・要約AIです。文字起こしを分析し、以下のステップに従ってください。

【ステップ1：会議種別の自動判定】
発言者の人数や対話スタイル（一対一の対話か、複数人による議論・報告か）から、この録音が
「1on1（1対1の面談・個別打ち合わせ）」か「group（複数人が参加する会議）」かを判定してください。

【ステップ2：判定結果に応じた出力】
以下のJSON形式で出力してください。meetingTypeが"1on1"の場合のみanalysisキーを含め、
"group"の場合はanalysisキー自体を出力しないでください。

{
  "meetingType": "1on1" または "group",
  "sections": [ ...下記のいずれかのフォーマット... ],
  "analysis": { ...meetingTypeが"1on1"の場合のみ... }
}

■ meetingTypeが"1on1"の場合のsections:
[
  {"key":"goal","label":"今日のゴール","emoji":"🎯","items":["..."]},
  {"key":"voice","label":"本人の声","emoji":"💬","items":["..."]},
  {"key":"action","label":"アクション","emoji":"✅","items":["..."]},
  {"key":"follow","label":"フォロー事項","emoji":"📅","items":["..."]}
]

■ meetingTypeが"group"の場合のsections:
[
  {"key":"purpose","label":"目的・アジェンダ","emoji":"🎯","items":["..."]},
  {"key":"decisions","label":"主な決定事項","emoji":"✅","items":["..."]},
  {"key":"todos","label":"担当者ごとのToDo","emoji":"📋","items":["<担当者名>：<タスク内容>（期日：<期日、不明なら未定>）", "..."]},
  {"key":"pending","label":"保留事項・継続協議テーマ","emoji":"⏳","items":["..."]}
]

【sections共通】各2〜4項目。情報がない場合は["特になし"]

【analysis】（1on1の場合のみ）
{
  "speakingRatio":{"self":<進行役の発話割合(数値0-100)>,"other":<相手の発話割合(数値0-100)>},
  "listeningScore":<傾聴度スコア(数値0-100)>,
  "listeningComment":"<傾聴度についての一言コメント（30文字程度）>",
  "openQuestionRatio":<オープンクエスチョンの割合(数値0-100)>
}
- speakingRatio: self+other=100になるようにしてください。
- listeningScore: 相手の発言を受けて深掘りする質問ができているか、話を遮っていないか等から算出。
- openQuestionRatio: 「はい/いいえ」で終わる質問ではなく、「なぜ」「どう思う」等の深掘りする質問の割合。
- いずれも文字起こしのみからの推定であることを前提に、妥当な数値を出してください。`;
}

// Geminiの呼び出しはAPIキーではなく、スクリプト所有者のGoogleログイン権限
// （OAuthトークン）で行う。組織のポリシーで従来形式（AIza…）のキーが作れず、
// 新形式（AQ.…）のキーはこの組織では401になってしまうため。
// x-goog-user-projectは、利用料・利用枠をどのGoogle Cloudプロジェクトに付けるかの
// 指定（指定しないとApps Scriptの非表示の既定プロジェクト扱いになり、そこでは
// Gemini APIが有効になっていないため失敗する）。
// 必要な権限の範囲は appsscript.json の oauthScopes で宣言している。
function getGeminiAuth() {
  return { token: ScriptApp.getOAuthToken(), projectId: requireGcpProjectId() };
}

function requireGcpProjectId() {
  const projectId = PropertiesService.getScriptProperties().getProperty("GCP_PROJECT_ID");
  if (!projectId) throw new Error("GCP_PROJECT_ID がスクリプトプロパティに設定されていません");
  return projectId;
}

function geminiHeaders(auth) {
  return {
    "Authorization": "Bearer " + auth.token,
    "x-goog-user-project": auth.projectId
  };
}

function makeOptions(payload, auth) {
  return {
    method: "POST",
    contentType: "application/json",
    headers: geminiHeaders(auth),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

// ================================================================
// レコード更新
// ================================================================
function updateRecord(body) {
  const { id, sections, status, processError } = body;
  if (!id) return { success: false, error: "id is required" };

  // 行の検索と書き込みの間に他の実行が同じ行をいじる余地をなくすため短時間ロックする
  return withShortLock(() => {
    const sheet = recordsSheet();
    const targetRow = findRecordRowById(sheet, id);
    if (targetRow < 0) return { success: false, error: "Record not found: " + id };

    if (sections !== undefined && sections !== null) {
      sheet.getRange(targetRow, COL.SECTIONS).setValue(JSON.stringify(stripTranscript(sections)));
    }
    if (status !== undefined)       sheet.getRange(targetRow, COL.STATUS).setValue(status);
    if (processError !== undefined) sheet.getRange(targetRow, COL.PROCESS_ERROR).setValue(processError);
    console.log("[updateRecord] 更新完了 row:", targetRow, "id:", id);
    return { success: true };
  });
}

// ================================================================
// レコード削除
// ================================================================
function deleteRecord(body) {
  const { id } = body;
  if (!id) return { success: false, error: "id required" };

  // 行の検索と削除の間に他の実行が行番号をずらす（挿入・削除）余地をなくす
  return withShortLock(() => {
    const sheet = recordsSheet();
    const targetRow = findRecordRowById(sheet, id);
    if (targetRow < 0) return { success: false, error: "Record not found: " + id };
    sheet.deleteRow(targetRow);
    return { success: true };
  });
}

// ================================================================
// ウォームアップ（5分おきの定期実行）
// ================================================================
function warmup() {
  try {
    const name = SS().getName();
    console.log("[warmup] OK:", name, new Date().toLocaleString("ja-JP"));
  } catch (e) {
    console.error("[warmup] error:", e.message);
  }
  reapStaleProcessing();
}

// 要約中にGASの実行時間上限などで異常終了すると、行が"processing"のまま
// 取り残されることがある。一定時間"processing"のままの行を"queued"に戻し、
// 次回の定期実行で拾い直す。
function reapStaleProcessing() {
  try {
    const sheet = recordsSheet();
    const lastRow = sheet.getLastRow();
    if (lastRow <= HEADER_ROW) return;

    const numRows = lastRow - HEADER_ROW;
    const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, numRows, 1).getValues();
    const startedAts = sheet.getRange(HEADER_ROW + 1, COL.PROCESSING_STARTED_AT, numRows, 1).getValues();
    const thresholdMs = STALE_PROCESSING_MINUTES * 60 * 1000;
    const now = new Date().getTime();
    let reverted = 0;

    for (let i = 0; i < numRows; i++) {
      if (String(statuses[i][0]) !== "processing") continue;
      const startedAt = startedAts[i][0];
      const startedMs = startedAt instanceof Date ? startedAt.getTime() : 0;
      if (!startedMs || now - startedMs > thresholdMs) {
        sheet.getRange(HEADER_ROW + 1 + i, COL.STATUS).setValue("queued");
        reverted++;
      }
    }
    if (reverted > 0) console.log("[reapStaleProcessing] " + reverted + "件を再投入しました");
  } catch (e) {
    console.error("[reapStaleProcessing] error:", e.message);
  }
}

// ================================================================
// ユーティリティ
// ================================================================
function SS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// recordsシートを返す（なければ作る）。古い16列のままなら、読み書きすると
// 列がずれて記録が壊れるため、migrateRecordsSheetを実行するまでエラーにする。
let recordsSheetChecked_ = null;
function recordsSheet() {
  if (recordsSheetChecked_) return recordsSheetChecked_;
  let sheet = SS().getSheetByName(SHEET_RECORDS);
  if (!sheet) {
    sheet = createRecordsSheet_(SHEET_RECORDS);
  } else if (isOldLayout_(sheet)) {
    throw new Error("記録シートの移行が終わっていません。管理者がmigrateRecordsSheetを実行するまでお待ちください。");
  }
  recordsSheetChecked_ = sheet;
  return sheet;
}

function createRecordsSheet_(name) {
  const sheet = SS().insertSheet(name);
  sheet.getRange(1, 1, 1, NUM_COLS).setValues([HEADERS]);
  sheet.getRange(1, 1, 1, NUM_COLS).setFontWeight("bold").setBackground("#E8EAF6");
  sheet.setFrozenRows(1);
  // 名前〜エラーの文字の列は、数字や日付に自動変換されないよう「書式なしテキスト」にする
  sheet.getRange(1, COL.MEMBER, sheet.getMaxRows(), COL.PROCESS_ERROR - COL.MEMBER + 1).setNumberFormat("@");
  sheet.setColumnWidth(COL.ID, 90);
  sheet.setColumnWidth(COL.DATE, 140);
  sheet.setColumnWidth(COL.SECTIONS, 400);
  sheet.setColumnWidth(COL.TRANSCRIPT, 400);
  SpreadsheetApp.flush();
  return sheet;
}

function isOldLayout_(sheet) {
  return sheet.getLastColumn() >= OLD_NUM_COLS &&
    String(sheet.getRange(1, OLD_NUM_COLS).getValue()) === "transcript";
}

// recordsシートの見出しを除く全行（古い順）
function readAllRows() {
  const sheet = recordsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return [];
  return sheet.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, NUM_COLS).getValues();
}

// IDで行番号を探す（見つからなければ-1）
function findRecordRowById(sheet, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return -1;
  const ids = sheet.getRange(HEADER_ROW + 1, COL.ID, lastRow - HEADER_ROW, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return HEADER_ROW + 1 + i;
  }
  return -1;
}

function parseSections(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(String(raw));
  } catch (e) {
    return null;
  }
}

function stripTranscript(sections) {
  if (!sections || typeof sections !== "object") return sections;
  const copy = Object.assign({}, sections);
  delete copy._transcript;
  return copy;
}

function rowToRecord(row) {
  try {
    const idVal = row[COL.ID - 1];
    if (!idVal && idVal !== 0) return null;

    return {
      id:            String(idVal),
      date:          String(row[COL.DATE - 1] || ""),
      member:        String(row[COL.MEMBER - 1] || ""),
      interviewee:   String(row[COL.INTERVIEWEE - 1] || ""),
      sections:     stripTranscript(parseSections(row[COL.SECTIONS - 1])),
      hasTranscript: !!rowTranscript(row),
      status:        String(row[COL.STATUS - 1] || ""),
      processError:  String(row[COL.PROCESS_ERROR - 1] || "")
    };
  } catch (e) {
    return null;
  }
}

// ================================================================
// 定期実行の設定（Apps Scriptエディタから手動で一度だけ実行）
// ================================================================
// このプロジェクトの定期実行をすべて消してから、必要なものだけ作り直す。
// ・runPendingJobs: 1分おき（受け付け済みで要約されていない記録を要約する）
// ・warmup: 5分おき（応答を速く保つ＋止まった処理の拾い直し）
// 何回実行しても同じ状態になる。Webアプリ経由で作ったトリガーは再デプロイで
// 無効になることがあるため、必ずエディタから実行する。
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    try {
      ScriptApp.deleteTrigger(t);
    } catch (e) {
      console.warn("[setupTriggers] 既存トリガーの削除に失敗:", t.getHandlerFunction(), e.message);
    }
  });
  ScriptApp.newTrigger("runPendingJobs").timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger("warmup").timeBased().everyMinutes(5).create();
  console.log("[setupTriggers] 定期実行を設定しました: runPendingJobs（1分おき）, warmup（5分おき）");
}

// ================================================================
// 記録シートの移行（Apps Scriptエディタから手動で一度だけ実行）
// ================================================================
// 音声を扱っていた頃の16列の records シートを、今使っている9列に作り直す。
// ・今の records は「records_旧」に名前を変えて残す（中身を確認してから手で削除する）
// ・要約の中に重複して入っていた文字起こし(_transcript)は「文字起こし」列にまとめる
// ・使っていない members / chunks シートは削除する
// 移行済みなら記録には何もしないので、何回実行しても安全。
function migrateRecordsSheet() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000); // 移行中にアプリからの書き込みが割り込まないようにする
  try {
    const ss = SS();
    const old = ss.getSheetByName(SHEET_RECORDS);
    if (!old) {
      recordsSheet();
      console.log("records シートが無かったので、新しい形で作りました");
    } else if (!isOldLayout_(old)) {
      console.log("records シートはすでに新しい形です（記録はそのまま）");
    } else {
      const lastRow = old.getLastRow();
      const values = lastRow > HEADER_ROW ? old.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, OLD_NUM_COLS).getValues() : [];
      const rows = values.filter(r => String(r[OLD_COL.ID - 1] || "")).map(r => {
        const rawSections = r[OLD_COL.SECTIONS - 1];
        const parsed = parseSections(rawSections);
        const transcript = String(r[OLD_COL.TRANSCRIPT - 1] || "") ||
          (parsed && parsed._transcript ? String(parsed._transcript) : "");
        const sections = parsed ? JSON.stringify(stripTranscript(parsed)) : String(rawSections || "");
        const row = [];
        row[COL.ID - 1]                    = r[OLD_COL.ID - 1];
        row[COL.DATE - 1]                  = r[OLD_COL.DATE - 1];
        row[COL.MEMBER - 1]                = String(r[OLD_COL.MEMBER - 1] || "");
        row[COL.INTERVIEWEE - 1]           = String(r[OLD_COL.INTERVIEWEE - 1] || "");
        row[COL.STATUS - 1]                = String(r[OLD_COL.STATUS - 1] || "");
        row[COL.SECTIONS - 1]              = sections;
        row[COL.TRANSCRIPT - 1]            = transcript;
        row[COL.PROCESS_ERROR - 1]         = String(r[OLD_COL.PROCESS_ERROR - 1] || "");
        row[COL.PROCESSING_STARTED_AT - 1] = r[OLD_COL.PROCESSING_STARTED_AT - 1];
        return row;
      });

      const backupName = uniqueSheetName_(SHEET_RECORDS + "_旧");
      old.setName(backupName);
      const sheet = createRecordsSheet_(SHEET_RECORDS);
      if (rows.length) sheet.getRange(HEADER_ROW + 1, 1, rows.length, NUM_COLS).setValues(rows);
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(1);
      console.log("✓ records を新しい形に作り直しました（" + rows.length + "件）。元のシートは「" + backupName + "」として残しています");
    }

    OLD_SHEET_NAMES.forEach(name => {
      const s = ss.getSheetByName(name);
      if (s) {
        ss.deleteSheet(s);
        console.log("✓ 使っていない「" + name + "」シートを削除しました");
      }
    });
  } finally {
    lock.releaseLock();
  }
}

function uniqueSheetName_(base) {
  let name = base;
  for (let i = 2; SS().getSheetByName(name); i++) name = base + i;
  return name;
}

// ================================================================
// Gemini接続の診断（Apps Scriptエディタから手動実行）
// ================================================================
// 実際に使っているモデル（GEMINI_MODEL）に短い文章を送り、成功するか確認する。
function testGeminiModel() {
  let auth;
  try {
    auth = getGeminiAuth();
  } catch (e) {
    console.log("✗ 設定エラー:", e.message);
    return;
  }
  console.log("利用プロジェクト:", auth.projectId);

  const url = GEMINI_API_BASE + GEMINI_MODEL + ":generateContent";
  const payload = { contents: [{ parts: [{ text: "日本語でこんにちはと返してください。" }] }] };
  try {
    const res = UrlFetchApp.fetch(url, makeOptions(payload, auth));
    const code = res.getResponseCode();
    const data = JSON.parse(res.getContentText());
    if (code === 200 && data.candidates) {
      console.log("✓ OK:", GEMINI_MODEL, "→", data.candidates[0].content.parts[0].text.slice(0, 30));
    } else {
      console.log("✗ NG:", GEMINI_MODEL, "→", code, data.error ? data.error.status + " / " + data.error.message : res.getContentText().slice(0, 300));
    }
  } catch (e) {
    console.log("✗ ERR:", GEMINI_MODEL, "→", e.message);
  }
}

// 合言葉が設定されているかの確認（値そのものはログに出さない）
function checkPasscodeSetting() {
  const v = String(PropertiesService.getScriptProperties().getProperty("APP_PASSCODE") || "").trim();
  if (!v) console.log("✗ APP_PASSCODE が未設定です。この状態ではアプリが使えません。");
  else console.log("✓ APP_PASSCODE は設定済みです（" + v.length + "文字）");
}
