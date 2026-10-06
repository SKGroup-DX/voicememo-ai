// ================================================================
// ボイスメモ要約 - GAS バックエンド
// ================================================================
// このファイルはApps Scriptエディタの「コード.gs」に貼り付けて使う。
// 合言葉（APP_PASSCODE）とGoogle CloudのプロジェクトID（GCP_PROJECT_ID）は
// コードには書かず、Apps Scriptの「プロジェクトの設定」→「スクリプト プロパティ」に
// 保存する（このリポジトリは公開されているため）。

const SHEET_RECORDS    = "records";
// 使うモデルは、スクリプトプロパティ GEMINI_MODEL で切り替えられる（コードの書き換えや
// 再デプロイは不要）。未設定ならこの既定のモデルを使う。
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_API_BASE  = "https://generativelanguage.googleapis.com/v1/models/";

// recordsシートの列定義
const COL = { ID:1, DATE:2, MEMBER:3, INTERVIEWEE:4, STATUS:5, SECTIONS:6, TRANSCRIPT:7, PROCESS_ERROR:8, PROCESSING_STARTED_AT:9 };
const NUM_COLS    = 9;
const HEADERS     = ["ID", "日時", "名前", "相手", "状態", "要約", "文字起こし", "エラー", "処理開始時刻"];
// 状態列の値: "queued"(要約待ち) | "processing"(要約中) | "done"(完了) | "error"(失敗)

const STALE_PROCESSING_MINUTES = 10; // これ以上"processing"のままの行は実行が異常終了したとみなし再投入する
const HEADER_ROW  = 1;
const MAX_TRANSCRIPT_CHARS = 30000;  // アプリ側の上限と合わせる
const MAX_MEMBER_CHARS = 50;
const MAX_INTERVIEWEE_CHARS = 100;
const MAX_SUMMARY_JSON_CHARS = 20000; // 要約1件の大きさの上限（1セルは5万文字まで）
const HISTORY_MAX_LIMIT = 50;
const STATUS_MAX_IDS = 20;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 合言葉を間違えた時に応答を遅らせ、総当たりで合言葉を探られにくくする。
// ただし短時間に大量の失敗が来ているときは、待たせる処理がGASの同時実行の枠を
// 埋めてしまうので、待たずにすぐ断る。
const AUTH_FAIL_WAIT_MS = 2000;
const AUTH_FAIL_BURST = 20;          // 10分間にこれを超えて失敗が続いたら、待たずに断る
const AUTH_FAIL_WINDOW_SEC = 10 * 60;

// スクリプトプロパティは1回の実行の中でまとめて読む（何度も読まないように）
let propsCache_ = null;
function prop_(key) {
  if (!propsCache_) propsCache_ = PropertiesService.getScriptProperties().getProperties();
  return String(propsCache_[key] || "");
}
function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
  if (propsCache_) propsCache_[key] = value;
}

function geminiModel() {
  return prop_("GEMINI_MODEL").trim() || DEFAULT_GEMINI_MODEL;
}

// 利用者にそのまま見せてよい文言を持つエラー。それ以外のエラーの詳細（内部の
// 仕組みやGoogle Cloudの情報を含むことがある）はログにだけ残し、アプリには出さない。
function userError_(message, extra) {
  const e = new Error(message);
  e.userMessage = message;
  if (extra) Object.assign(e, extra);
  return e;
}
const GENERIC_ERROR_MESSAGE = "サーバーでエラーが発生しました。少し時間をおいてもう一度お試しください。";
const BUSY_MESSAGE = "混み合っています。少し待ってからもう一度お試しください。";

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
      if (recordAuthFailure_() <= AUTH_FAIL_BURST) Utilities.sleep(AUTH_FAIL_WAIT_MS);
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
      case "getRecordStatuses":
        result = getRecordStatuses(body); break;
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
        result = updateSummary(body); break;
      case "deleteRecord":
        result = deleteRecord(body); break;
      default:
        result = { success: false, error: "Unknown action: " + action };
    }

    return jsonResponse(result);
  } catch (err) {
    if (err.busy) return jsonResponse({ success: false, busy: true, error: BUSY_MESSAGE });
    console.error("[doPost] error:", err.message, err.stack);
    return jsonResponse({ success: false, error: err.userMessage || GENERIC_ERROR_MESSAGE });
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
  const expected = prop_("APP_PASSCODE").trim();
  if (!expected) {
    console.error("[auth] APP_PASSCODE がスクリプトプロパティに設定されていません");
    return false;
  }
  return typeof key === "string" && key.trim() === expected;
}

// 合言葉の失敗回数（直近10分・全体）を数えて返す
function recordAuthFailure_() {
  try {
    const cache = CacheService.getScriptCache();
    const n = (parseInt(cache.get("authFailures"), 10) || 0) + 1;
    cache.put("authFailures", String(n), AUTH_FAIL_WINDOW_SEC);
    if (n === AUTH_FAIL_BURST + 1) console.warn("[auth] 合言葉の失敗が短時間に続いています（10分間に" + n + "回以上）");
    return n;
  } catch (e) {
    return 0;
  }
}

// ================================================================
// ロック
// ================================================================
// シートの書き込みは「IDで行を探す → その行に書く」ので、途中で他の処理が行を
// 削除すると行がずれて別の記録に書いてしまう。書き込みはすべてロックの中で行い、
// ロックが取れないときは書き込まずに「混み合っています」を返す（アプリが自動で
// 送り直す）。以前はロックが取れなくてもそのまま書き込んでいた。
function withLock_(fn, waitMs) {
  const lock = LockService.getScriptLock();
  let got = false;
  try {
    got = lock.tryLock(waitMs || 10000);
  } catch (e) {}
  if (!got) throw userError_(BUSY_MESSAGE, { busy: true });
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush(); // 書き込みを確定させてから放す（同時に動く処理がすぐ読めるように）
    lock.releaseLock();
  }
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

  // 文字起こしの本文は検索するときだけ読む（記録が増えるほど重くなる列のため）
  const rows = terms.length ? readAllRows() : readRowsWithoutTranscript_();
  const matched = [];
  for (let i = rows.length - 1; i >= 0; i--) { // 新しい順
    const row = rows[i];
    if (readText_(row[COL.MEMBER - 1]) !== member) continue;
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
  const secs = (rec.sections && Array.isArray(rec.sections.sections)) ? rec.sections.sections : [];
  secs.forEach(s => {
    if (!s) return;
    parts.push(String(s.label || ""));
    if (Array.isArray(s.items)) s.items.forEach(i => parts.push(String(i)));
  });
  return parts.join("\n").toLowerCase();
}

// ================================================================
// 文字起こし本文の取得（要約画面で「文字起こし」を開いた時だけ呼ばれる）
// ================================================================
function getTranscript(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  const values = readRowById_(id);
  if (!values) return { success: false, error: "記録が見つかりません" };
  return { success: true, transcript: rowTranscript(values) };
}

// IDで1行を読む。探してから読むまでの間に行がずれた場合（削除など）に、別の記録を
// 返さないよう、読んだ行のIDを確かめる。
function readRowById_(id) {
  const sheet = recordsSheet();
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = findRecordRowById(sheet, id);
    if (row < 0) return null;
    const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
    if (String(values[COL.ID - 1]) === String(id)) return values;
  }
  return null;
}

function rowTranscript(row) {
  return readText_(row[COL.TRANSCRIPT - 1]);
}

// ================================================================
// 処理状況の取得（ポーリング用・軽量）
// ================================================================
function getRecordStatus(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { found: false, error: "id required" };
  const values = readRowById_(id);
  if (!values) return { found: false };
  return statusOf_(values);
}

// 複数の記録の状況をまとめて返す（アプリの状況確認を1回の通信で済ませる）
function getRecordStatuses(body) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, STATUS_MAX_IDS);
  const wanted = {};
  ids.forEach(id => { wanted[id] = true; });
  const results = {};
  readRowsWithoutTranscript_().forEach(row => {
    const id = String(row[COL.ID - 1]);
    if (wanted[id]) results[id] = statusOf_(row);
  });
  ids.forEach(id => { if (!results[id]) results[id] = { found: false }; });
  return { success: true, results };
}

function statusOf_(values) {
  return {
    found: true,
    status: String(values[COL.STATUS - 1] || ""),
    sections: stripTranscript(parseSections(values[COL.SECTIONS - 1])),
    error: readText_(values[COL.PROCESS_ERROR - 1])
  };
}

// ================================================================
// 文字起こしの受け付け
// ================================================================
// アプリは文字起こしを保存（＝受け付け）した時点ですぐ利用者に返す。要約開始
// （processRecord）は同時に送られてくる。processRecordが届かなかった場合も、
// "queued"の記録は1分おきの定期実行（runPendingJobs）が要約する。
function submitTranscript(body) {
  const member      = String(body.member || "").trim();
  const interviewee = String(body.interviewee || "").trim().slice(0, MAX_INTERVIEWEE_CHARS);
  const transcript  = String(body.transcript || "").trim();

  if (!member) return { success: false, error: "member required" };
  if (member.length > MAX_MEMBER_CHARS) return { success: false, error: "名前が長すぎます（" + MAX_MEMBER_CHARS + "文字まで）" };
  if (!transcript) return { success: false, error: "文字起こしテキストがありません" };
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return { success: false, error: "文字数が上限（" + MAX_TRANSCRIPT_CHARS + "文字）を超えています" };
  }

  // 記録の番号はアプリが送ってくる（送り直しても同じ番号）。保存した後に応答だけが
  // 届かずアプリが自動で送り直した場合に、同じ記録を2件作らないため。
  // 番号が付いていない・形が正しくない場合はこちらで作る。
  const clientId = String(body.id || "");
  const newId    = UUID_PATTERN.test(clientId) ? clientId.toLowerCase() : Utilities.getUuid();
  const recordDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

  return withLock_(() => {
    const sheet = recordsSheet();
    const existing = findRecordRowById(sheet, newId);
    if (existing >= 0) {
      const status = String(sheet.getRange(existing, COL.STATUS).getValue() || "");
      console.log("[submitTranscript] 受け付け済みの送り直しのため、新しく作らない id:", newId);
      return { success: true, id: newId, status, duplicate: true };
    }
    sheet.appendRow([
      newId,                    // COL.ID
      recordDate,               // COL.DATE
      cellText_(member),        // COL.MEMBER
      cellText_(interviewee),   // COL.INTERVIEWEE
      "queued",                 // COL.STATUS
      "",                       // COL.SECTIONS: まだなし
      cellText_(transcript),    // COL.TRANSCRIPT
      "",                       // COL.PROCESS_ERROR
      ""                        // COL.PROCESSING_STARTED_AT
    ]);
    console.log("[submitTranscript] 受け付け完了 id:", newId);
    return { success: true, id: newId, status: "queued" };
  });
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

// その場での要約（アプリが受け付けと同時に呼ぶ）。利用回数の上限（429）に当たっても、
// Geminiが指示する時間（60秒まで）ならその場で待つ。定期実行に回すと拾われるまで
// 最大1分余計にかかるため。アプリが待ちきれずに通信を切っても、GAS側の処理は最後まで
// 続き、結果はアプリの状況確認で表示される。
const RETRY_POLICY_SYNC = { maxAttempts: 4, budgetMs: 100 * 1000, max429WaitSec: 60, callReserveMs: 0, serverErrorWaitSec: () => 2 };
// 定期実行での要約。1件あたり最大4分。待ってからやり直す前に、最後の呼び出しに
// かかりうる時間（60秒）を見込んで、締め切りを越えそうならやり直さない。
const RETRY_POLICY_BACKGROUND = { maxAttempts: 6, budgetMs: 4 * 60 * 1000, max429WaitSec: 60, callReserveMs: 60 * 1000, serverErrorWaitSec: attempt => Math.min(attempt * 5, 20) };
// 1回の定期実行で新しい記録を拾い始めるのは、開始からこの時間まで
const RUN_PICKUP_LIMIT_MS = 60 * 1000;
// 1回の定期実行は、GASの実行時間の上限（6分）より手前のこの時間までに必ず終える
const RUN_HARD_LIMIT_MS = 330 * 1000;
// 受け付け（submitTranscript）と要約開始（processRecord）はアプリから同時に送られて
// くるので、要約開始が先に着いた場合は、受け付けの保存をこの時間まで待つ
const WAIT_FOR_SUBMIT_MS = 20 * 1000;

function processRecord(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  const auth = getGeminiAuth();
  let job = claimQueuedRow_(id);
  const waitUntil = Date.now() + WAIT_FOR_SUBMIT_MS;
  while (!job && Date.now() < waitUntil && findRecordRowById(recordsSheet(), id) < 0) {
    Utilities.sleep(1000);
    job = claimQueuedRow_(id);
  }
  if (!job) return { success: true, id, status: "skipped" };
  if (!job.transcript) {
    finishJob_(job, { error: "文字起こしテキストがありません" });
    return { success: true, id, status: "error" };
  }
  try {
    const t0 = Date.now();
    const sections = callGeminiSummarize(job.transcript, auth, RETRY_POLICY_SYNC);
    console.log("[processRecord] 要約にかかった時間:", ((Date.now() - t0) / 1000).toFixed(1), "秒 ／ 文字数:", job.transcript.length, "／ 種別:", sections.meetingType);
    finishJob_(job, { sections });
    return { success: true, id, status: "done", sections };
  } catch (e) {
    if (e.permanent) {
      // やり直しても同じ結果になるもの（安全確認での拒否など）は、定期実行に回さず失敗にする
      console.warn("[processRecord] やり直しても結果が変わらないため失敗にする id:", id, e.message);
      finishJob_(job, { error: e.userMessage || GENERIC_ERROR_MESSAGE });
      return { success: true, id, status: "error", error: e.userMessage || GENERIC_ERROR_MESSAGE };
    }
    console.warn("[processRecord] その場での要約をあきらめ、定期実行に任せる id:", id, e.message);
    finishJob_(job, { requeue: true });
    return { success: true, id, status: "queued" };
  }
}

// 定期実行（setupTriggersで1分おきに設定）。受け付け済みの記録を1件ずつ要約する。
// 複数件たまっていても、拾い始めるのは開始から1分まで（長引いた分は次の回に回す）。
function runPendingJobs() {
  const startedAt = Date.now();
  // 要約待ちが無ければ、状態の列だけ読んですぐ終える（毎分動くので軽くしておく）
  if (findQueuedRow_(recordsSheet()) < 0) return;
  let auth;
  try {
    auth = getGeminiAuth();
  } catch (e) {
    console.error("[runPendingJobs] 認証情報を用意できないため中断:", e.message);
    return;
  }
  const runEnd = startedAt + RUN_HARD_LIMIT_MS;
  while (Date.now() - startedAt < RUN_PICKUP_LIMIT_MS) {
    const job = claimQueuedRow_(null);
    if (!job) return;
    try {
      if (!job.transcript) throw userError_("文字起こしテキストがありません", { permanent: true });
      console.log("[runPendingJobs] 要約開始 id:", job.id);
      const t0 = Date.now();
      const policy = Object.assign({}, RETRY_POLICY_BACKGROUND, {
        deadline: Math.min(Date.now() + RETRY_POLICY_BACKGROUND.budgetMs, runEnd)
      });
      const sections = callGeminiSummarize(job.transcript, auth, policy);
      const result = finishJob_(job, { sections });
      console.log("[runPendingJobs] 完了 id:", job.id, "（" + result + "）", ((Date.now() - t0) / 1000).toFixed(1) + "秒");
    } catch (e) {
      const result = finishJob_(job, { error: e.userMessage || GENERIC_ERROR_MESSAGE });
      console.error("[runPendingJobs] 失敗 id:", job.id, e.message, "（" + result + "）");
    }
  }
}

// 状態の列だけを読んで、要約待ち（queued）の行を探す（なければ-1）
function findQueuedRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return -1;
  const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, lastRow - HEADER_ROW, 1).getValues();
  for (let i = 0; i < statuses.length; i++) {
    if (String(statuses[i][0]) === "queued") return HEADER_ROW + 1 + i;
  }
  return -1;
}

// queuedの行を1件選んでprocessingに切り替え、内容と目印を返す（なければnull）。
// idを指定するとその行だけを対象にする。ロックが取れなければnull（次の機会に任せる）。
function claimQueuedRow_(id) {
  const lock = LockService.getScriptLock();
  let gotLock = false;
  try {
    gotLock = lock.tryLock(10000);
  } catch (e) {}
  if (!gotLock) return null;
  try {
    const sheet = recordsSheet();
    const row = id ? findRecordRowById(sheet, id) : findQueuedRow_(sheet);
    if (row < 0) return null;
    const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
    if (String(values[COL.STATUS - 1] || "") !== "queued") return null;
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
    SpreadsheetApp.flush(); // ロックを放す前に書き込みを確定させ、他の処理から見えるようにする
    lock.releaseLock();
  }
}

// 要約の結果を書き込む。outcome は { sections } | { requeue: true } | { error: "..." }。
// 要約できた場合は、まだ完了になっていなければ（二重に処理された場合も）書き込む。
// 戻す・失敗にするのは、その行を今も自分が処理している場合だけ。
// 要約に時間をかけた後なので、ロックは長めに（30秒）待つ。
function finishJob_(job, outcome) {
  try {
    return withLock_(() => {
      const sheet = recordsSheet();
      const row = findRecordRowById(sheet, job.id);
      if (row < 0) return "削除済み";
      const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
      const status = String(values[COL.STATUS - 1] || "");
      if (outcome.sections) {
        if (status === "done") return "完了済みのため書き込まず";
        sheet.getRange(row, COL.SECTIONS).setValue(JSON.stringify(outcome.sections));
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
      sheet.getRange(row, COL.PROCESS_ERROR).setValue(cellText_(outcome.error || GENERIC_ERROR_MESSAGE));
      return "失敗として記録";
    }, 30000);
  } catch (e) {
    // ロックが取れなかった場合。processingのまま残り、10分後に拾い直される
    console.error("[finishJob_] 結果を書き込めませんでした id:", job.id, e.message);
    return "書き込み失敗";
  }
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
  return withLock_(() => {
    const sheet = recordsSheet();
    const row = findRecordRowById(sheet, id);
    if (row < 0) return { success: false, error: "記録が見つかりません" };
    const status = String(sheet.getRange(row, COL.STATUS).getValue() || "");
    if (status !== "error") return { success: true, status };
    sheet.getRange(row, COL.STATUS).setValue("queued");
    sheet.getRange(row, COL.PROCESS_ERROR).setValue("");
    console.log("[retryRecord] 再受け付け完了 id:", id);
    return { success: true, status: "queued" };
  });
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
const RATE_LIMIT_MESSAGE = "AIの利用回数が上限に達しています（無料枠）。少し時間をおいて再試行してください。";

function fetchGeminiWithRetry(url, payload, label, auth, policy) {
  const p = policy || RETRY_POLICY_BACKGROUND;
  const deadline = p.deadline || (Date.now() + p.budgetMs);
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
      busyMessage = RATE_LIMIT_MESSAGE;
      if (waitSec > p.max429WaitSec) {
        throw userError_(RATE_LIMIT_MESSAGE, { detail: "再開まで約" + Math.ceil(waitSec) + "秒" });
      }
    } else if (RETRYABLE_SERVER_CODES.indexOf(resCode) !== -1 || isRetryableFinish_(resCode, resText)) {
      waitSec = p.serverErrorWaitSec(attempt);
      busyMessage = "AIが混み合っています。少し時間をおいて再試行してください。";
    } else {
      return resText;
    }

    if (attempt >= p.maxAttempts || Date.now() + waitSec * 1000 + (p.callReserveMs || 0) > deadline) {
      throw userError_(busyMessage);
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
    // JSON解析失敗はここではやり直さず、extractGeminiText側のエラーに委ねる
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

// 安全確認で止められた・長すぎて途中で止まったなど、やり直しても結果が変わらない理由
const BLOCKED_FINISH_REASONS = ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"];

// Geminiの応答から本文を取り出す。分かっている失敗の理由は、利用者向けの文言にする
// （以前はGeminiの応答の生の文字列をそのままエラーとして記録していた）。
function extractGeminiText(resText, label) {
  let data;
  try {
    data = JSON.parse(resText);
  } catch (e) {
    console.error("[" + label + "] 応答を解析できません:", String(resText).slice(0, 300));
    throw userError_("AIからの応答を読み取れませんでした。少し時間をおいて再試行してください。");
  }
  if (data.error) {
    // 400 のときは呼び出し側で設定を変えてやり直すため、コードをメッセージに含める
    console.error("[" + label + "] APIエラー:", data.error.code, data.error.message);
    throw userError_("AIの呼び出しでエラーが発生しました（" + data.error.code + "）。少し時間をおいて再試行してください。", {
      apiCode: data.error.code,
      apiMessage: String(data.error.message || "")
    });
  }
  const blockReason = data.promptFeedback && data.promptFeedback.blockReason;
  if (blockReason) {
    throw userError_("AIの安全確認により要約できませんでした（" + blockReason + "）。内容を見直してください。", { permanent: true });
  }

  const candidate = data.candidates && data.candidates[0];
  if (!candidate) throw userError_("AIから要約が返ってきませんでした。少し時間をおいて再試行してください。");

  const finishReason = String(candidate.finishReason || "");
  if (BLOCKED_FINISH_REASONS.indexOf(finishReason) !== -1) {
    throw userError_("AIの安全確認により要約できませんでした（" + finishReason + "）。内容を見直してください。", { permanent: true });
  }
  if (finishReason === "MAX_TOKENS") {
    throw userError_("要約が長くなりすぎて途中で止まりました。録音を短く分けて送ってください。", { permanent: true });
  }
  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts.filter(p => p && typeof p.text === "string" && !p.thought).map(p => p.text).join("");
  if (!text) {
    console.error("[" + label + "] 本文が空です finishReason=" + finishReason);
    throw userError_("AIから要約が返ってきませんでした。少し時間をおいて再試行してください。");
  }
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
// 400のエラー文がこれに当てはまるときだけ「高速化の設定のせい」とみなして覚える
// （一時的な別の原因の400で、ずっと遅い設定のままにならないように）
const FAST_CONFIG_ERROR_PATTERN = /thinking|response_?mime|mime_?type|generation_?config|unknown name/i;

function callGeminiSummarize(transcript, auth, policy) {
  const url = GEMINI_API_BASE + geminiModel() + ":generateContent";

  const prompt = getDefaultSystemPrompt(transcript.length) + "\n\n【文字起こし内容】\n" + transcript;
  const baseConfig = { temperature: 0.3, maxOutputTokens: 32768 };
  const buildPayload = config => ({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: config
  });

  // 高速化の設定を受け付けないモデルは覚えておき、次からは最初から従来の設定で呼ぶ
  // （毎回、断られる呼び出しを1回はさむと、その分だけ遅くなるため）
  const noFastKey = "NO_FAST_CONFIG_" + geminiModel();
  let jsonText;
  if (prop_(noFastKey)) {
    jsonText = extractGeminiText(fetchGeminiWithRetry(url, buildPayload(baseConfig), "要約", auth, policy), "要約");
  } else {
    try {
      const resText = fetchGeminiWithRetry(url, buildPayload(Object.assign({}, baseConfig, SUMMARIZE_FAST_CONFIG)), "要約", auth, policy);
      jsonText = extractGeminiText(resText, "要約");
    } catch (e) {
      if (e.apiCode !== 400) throw e;
      console.warn("[要約] 高速化の設定が受け付けられなかったため、従来の設定でやり直します:", e.apiMessage);
      const resText = fetchGeminiWithRetry(url, buildPayload(baseConfig), "要約", auth, policy);
      jsonText = extractGeminiText(resText, "要約");
      if (FAST_CONFIG_ERROR_PATTERN.test(e.apiMessage || "")) {
        setProp_(noFastKey, "1");
        console.log("[要約] " + geminiModel() + " では次から高速化の設定を使いません");
      }
    }
  }

  // Geminiがmarkdownコードブロックで返す場合に対応
  jsonText = jsonText.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    console.error("[要約] JSONとして読めない応答:", jsonText.slice(0, 300));
    throw userError_("AIの要約を読み取れませんでした。少し時間をおいて再試行してください。");
  }
  // 形を確かめて整える（崩れた形のまま保存すると、検索や画面の表示が壊れるため）。
  // 文字起こしはTRANSCRIPT列にあるので、要約には入れない。
  return normalizeSummary_(parsed);
}

// 要約の形を確かめて、アプリが表示できる形に整える。
// { meetingType: "1on1"|"group", sections: [{key,label,emoji,items:[文字列]}], analysis?(1on1のみ) }
function normalizeSummary_(raw) {
  const invalid = () => userError_("要約の形式が正しくありません。");
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.sections)) throw invalid();
  const toText = v => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).trim();
  const sections = raw.sections
    .filter(s => s && typeof s === "object" && toText(s.label))
    .slice(0, 12)
    .map(s => ({
      key: toText(s.key).slice(0, 40),
      label: toText(s.label).slice(0, 60),
      emoji: toText(s.emoji).slice(0, 8),
      items: (Array.isArray(s.items) ? s.items : (s.items == null ? [] : [s.items]))
        .map(i => toText(i).slice(0, 2000))
        .filter(Boolean)
        .slice(0, 30)
    }));
  if (!sections.length) throw invalid();

  const meetingType = raw.meetingType === "1on1" || raw.meetingType === "group"
    ? raw.meetingType
    : (raw.analysis ? "1on1" : "group");
  const out = { meetingType, sections };

  const a = raw.analysis;
  if (meetingType === "1on1" && a && typeof a === "object") {
    const pct = v => {
      const n = Number(v);
      return isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
    };
    const analysis = {};
    const sr = a.speakingRatio || {};
    const self = pct(sr.self);
    const other = pct(sr.other);
    if (self !== null && other !== null && self + other > 0) {
      const s = Math.round(self * 100 / (self + other));
      analysis.speakingRatio = { self: s, other: 100 - s }; // 合計を100にそろえる
    }
    if (pct(a.listeningScore) !== null) analysis.listeningScore = pct(a.listeningScore);
    if (a.listeningComment) analysis.listeningComment = toText(a.listeningComment).slice(0, 200);
    if (pct(a.openQuestionRatio) !== null) analysis.openQuestionRatio = pct(a.openQuestionRatio);
    if (Object.keys(analysis).length) out.analysis = analysis;
  }
  return out;
}

// 実質的なメインの要約プロンプト。1on1（面談）と複数人の会議が同じ入り口から
// 来るため、Gemini自身に種別を判定させ、判定結果に応じて出力フォーマットを
// 出し分けさせる。「発言比率・傾聴スコア」等の分析は1on1向けの指標なので、
// 複数人会議と判定された場合はanalysisキー自体を出力させない
// （アプリ側は analysis が無ければ単に表示しないだけなので、これだけで両対応できる）。
function getDefaultSystemPrompt(transcriptLength) {
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

【sections共通】${itemCountRule_(transcriptLength)}情報がない場合は["特になし"]

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

// 要約の各項目に入れる個数の目安。以前は長さに関係なく「各2〜4項目」だったため、
// 1時間ほどの会議では決定事項やToDoが抜けやすかった。長い文字起こしほど多く書かせる。
function itemCountRule_(transcriptLength) {
  const n = Number(transcriptLength) || 0;
  if (n >= 12000) return "各4〜7項目（重要なものから順に。決定事項と担当者ごとのToDoは漏れなく書く）。";
  if (n >= 4000) return "各3〜5項目（重要なものから順に）。";
  return "各2〜4項目。";
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
  const projectId = prop_("GCP_PROJECT_ID").trim();
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
// 要約の編集（アプリの「編集」→「保存」）
// ================================================================
function updateSummary(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  let sections;
  try {
    sections = normalizeSummary_(body.sections);
  } catch (e) {
    return { success: false, error: e.userMessage || "要約の形式が正しくありません。" };
  }
  const json = JSON.stringify(sections);
  if (json.length > MAX_SUMMARY_JSON_CHARS) {
    return { success: false, error: "要約が長すぎます（" + MAX_SUMMARY_JSON_CHARS + "文字まで）" };
  }
  return withLock_(() => {
    const sheet = recordsSheet();
    const row = findRecordRowById(sheet, id);
    if (row < 0) return { success: false, error: "記録が見つかりません" };
    sheet.getRange(row, COL.SECTIONS).setValue(json);
    console.log("[updateSummary] 更新完了 id:", id);
    return { success: true, sections };
  });
}

// ================================================================
// レコード削除
// ================================================================
function deleteRecord(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  // 行の検索と削除の間に他の実行が行番号をずらす（挿入・削除）余地をなくす
  return withLock_(() => {
    const sheet = recordsSheet();
    const row = findRecordRowById(sheet, id);
    if (row < 0) return { success: true, alreadyDeleted: true }; // 送り直しなどで既に消えている
    sheet.deleteRow(row);
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
// 次回の定期実行で拾い直す。読んでから書くまでの間に行がずれないよう、ロックの中で行う。
function reapStaleProcessing() {
  try {
    withLock_(() => {
      const sheet = recordsSheet();
      const lastRow = sheet.getLastRow();
      if (lastRow <= HEADER_ROW) return;
      const numRows = lastRow - HEADER_ROW;
      const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, numRows, 1).getValues();
      const startedAts = sheet.getRange(HEADER_ROW + 1, COL.PROCESSING_STARTED_AT, numRows, 1).getValues();
      const thresholdMs = STALE_PROCESSING_MINUTES * 60 * 1000;
      const now = Date.now();
      let reverted = 0;
      for (let i = 0; i < numRows; i++) {
        if (String(statuses[i][0]) !== "processing") continue;
        const startedMs = toMillis_(startedAts[i][0]);
        if (!startedMs || now - startedMs > thresholdMs) {
          sheet.getRange(HEADER_ROW + 1 + i, COL.STATUS).setValue("queued");
          reverted++;
        }
      }
      if (reverted > 0) console.log("[reapStaleProcessing] " + reverted + "件を再投入しました");
    });
  } catch (e) {
    console.warn("[reapStaleProcessing] 今回は見送り:", e.message);
  }
}

// ================================================================
// 古い文字起こしの自動削除（毎日の定期実行）
// ================================================================
// 1on1などの機密性に配慮し、一定日数（スクリプトプロパティ TRANSCRIPT_RETENTION_DAYS、
// 未設定なら90日）を過ぎた記録は、文字起こしの本文だけを消して要約は残す。
// 0 を設定すると消さない。要約待ち・失敗の記録は、やり直しに本文が要るので消さない。
const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 90;

function transcriptRetentionDays_() {
  const v = prop_("TRANSCRIPT_RETENTION_DAYS").trim();
  if (v === "") return DEFAULT_TRANSCRIPT_RETENTION_DAYS;
  const n = parseInt(v, 10);
  return isFinite(n) && n >= 0 ? n : DEFAULT_TRANSCRIPT_RETENTION_DAYS;
}

function purgeOldTranscripts() {
  const days = transcriptRetentionDays_();
  if (!days) {
    console.log("[purgeOldTranscripts] TRANSCRIPT_RETENTION_DAYS が0のため、消さずに終了");
    return;
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  try {
    withLock_(() => {
      const sheet = recordsSheet();
      const lastRow = sheet.getLastRow();
      if (lastRow <= HEADER_ROW) return;
      const n = lastRow - HEADER_ROW;
      const dates = sheet.getRange(HEADER_ROW + 1, COL.DATE, n, 1).getValues();
      const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, n, 1).getValues();
      const transcripts = sheet.getRange(HEADER_ROW + 1, COL.TRANSCRIPT, n, 1).getValues();
      let purged = 0;
      for (let i = 0; i < n; i++) {
        if (!transcripts[i][0] || String(statuses[i][0]) !== "done") continue;
        const t = recordMillis_(dates[i][0]);
        if (t && t < cutoff) {
          // 消す行だけを書き換える（列全体を書き戻すと、先頭が - などの本文が数式扱いになるため）
          sheet.getRange(HEADER_ROW + 1 + i, COL.TRANSCRIPT).setValue("");
          purged++;
        }
      }
      if (purged) console.log("[purgeOldTranscripts] " + days + "日より前の記録 " + purged + "件の文字起こしを消しました（要約は残しています）");
    }, 30000);
  } catch (e) {
    console.warn("[purgeOldTranscripts] 今回は見送り（次回に再実行）:", e.message);
  }
}

// 「日時」列の値（日付、または "yyyy-MM-dd HH:mm:ss" の文字）をミリ秒にする
function recordMillis_(v) {
  if (v instanceof Date) return v.getTime();
  const s = String(v || "").trim();
  if (!s) return 0;
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(" ", "T") : s);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ================================================================
// ユーティリティ
// ================================================================
function SS() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// recordsシートを返す（なければ作る）
let recordsSheetCache_ = null;
function recordsSheet() {
  if (recordsSheetCache_) return recordsSheetCache_;
  recordsSheetCache_ = SS().getSheetByName(SHEET_RECORDS) || createRecordsSheet_(SHEET_RECORDS);
  return recordsSheetCache_;
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

// 先頭が = + - @ の文字は、スプレッドシートで数式として扱われることがある
// （例：「- 議題」で始まる文字起こしがエラーになる、外部へデータを送る式が入る）。
// 書くときは先頭に ' を付けて文字として保存し、読むときに外す。
function cellText_(s) {
  const t = String(s == null ? "" : s);
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
function readText_(v) {
  const t = String(v == null ? "" : v);
  return /^'[=+\-@]/.test(t) ? t.slice(1) : t;
}

// recordsシートの見出しを除く全行（古い順）
function readAllRows() {
  const sheet = recordsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return [];
  return sheet.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, NUM_COLS).getValues();
}

// 一覧用：文字起こしの列を読まずに全行を返す（その列の位置には null を入れる）
function readRowsWithoutTranscript_() {
  const sheet = recordsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return [];
  const n = lastRow - HEADER_ROW;
  const before = sheet.getRange(HEADER_ROW + 1, 1, n, COL.TRANSCRIPT - 1).getValues();
  const after = sheet.getRange(HEADER_ROW + 1, COL.TRANSCRIPT + 1, n, NUM_COLS - COL.TRANSCRIPT).getValues();
  return before.map((r, i) => r.concat([null], after[i]));
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

// 古い記録には、要約の中に文字起こし(_transcript)が残っていることがあるので取り除いて返す
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
      member:        readText_(row[COL.MEMBER - 1]),
      interviewee:   readText_(row[COL.INTERVIEWEE - 1]),
      sections:      stripTranscript(parseSections(row[COL.SECTIONS - 1])),
      // 文字起こしの列を読んでいない場合（null）は、あるものとして扱う（受け付け時に必ず保存しているため）
      hasTranscript: row[COL.TRANSCRIPT - 1] === null ? true : !!rowTranscript(row),
      status:        String(row[COL.STATUS - 1] || ""),
      processError:  readText_(row[COL.PROCESS_ERROR - 1])
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
// ・purgeOldTranscripts: 毎日3時ごろ（古い記録の文字起こしの本文を消す）
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
  ScriptApp.newTrigger("purgeOldTranscripts").timeBased().everyDays(1).atHour(3).create();
  console.log("[setupTriggers] 定期実行を設定しました: runPendingJobs（1分おき）, warmup（5分おき）, purgeOldTranscripts（毎日3時ごろ）");
}

// ================================================================
// Gemini接続の診断（Apps Scriptエディタから手動実行）
// ================================================================
// 実際に使っているモデル（geminiModel()）に短い文章を送り、成功するか確認する。
function testGeminiModel() {
  let auth;
  try {
    auth = getGeminiAuth();
  } catch (e) {
    console.log("✗ 設定エラー:", e.message);
    return;
  }
  console.log("利用プロジェクト:", auth.projectId);

  const url = GEMINI_API_BASE + geminiModel() + ":generateContent";
  const payload = { contents: [{ parts: [{ text: "日本語でこんにちはと返してください。" }] }] };
  try {
    const res = UrlFetchApp.fetch(url, makeOptions(payload, auth));
    const code = res.getResponseCode();
    const data = JSON.parse(res.getContentText());
    if (code === 200 && data.candidates) {
      console.log("✓ OK:", geminiModel(), "→", data.candidates[0].content.parts[0].text.slice(0, 30));
    } else {
      console.log("✗ NG:", geminiModel(), "→", code, data.error ? data.error.status + " / " + data.error.message : res.getContentText().slice(0, 300));
    }
  } catch (e) {
    console.log("✗ ERR:", geminiModel(), "→", e.message);
  }
}

// ================================================================
// 使えるモデルの一覧（Apps Scriptエディタから手動実行）
// ================================================================
// 要約に使える（generateContentに対応した）モデルを表示する。軽量版（lite）を先に出す。
// 一覧の取得は要約の回数には数えられない。
function listGeminiModels() {
  let auth;
  try {
    auth = getGeminiAuth();
  } catch (e) {
    console.log("✗ 設定エラー:", e.message);
    return;
  }
  console.log("今使っているモデル:", geminiModel());
  const res = UrlFetchApp.fetch("https://generativelanguage.googleapis.com/v1/models?pageSize=200", {
    muteHttpExceptions: true,
    headers: geminiHeaders(auth)
  });
  if (res.getResponseCode() !== 200) {
    console.log("✗ 一覧を取得できませんでした:", res.getResponseCode(), res.getContentText().slice(0, 300));
    return;
  }
  const models = (JSON.parse(res.getContentText()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
    .map(m => ({ id: String(m.name || "").replace(/^models\//, ""), label: m.displayName || "" }));
  const lite = models.filter(m => /lite/i.test(m.id));
  console.log("=== 軽量版（lite）の候補 " + lite.length + "件 ===");
  lite.forEach(m => console.log("★ " + m.id + "  （" + m.label + "）"));
  console.log("=== その他 " + (models.length - lite.length) + "件 ===");
  models.filter(m => !/lite/i.test(m.id)).forEach(m => console.log("・" + m.id + "  （" + m.label + "）"));
}

// 合言葉が設定されているかの確認（値そのものはログに出さない）
function checkPasscodeSetting() {
  const v = prop_("APP_PASSCODE").trim();
  if (!v) console.log("✗ APP_PASSCODE が未設定です。この状態ではアプリが使えません。");
  else console.log("✓ APP_PASSCODE は設定済みです（" + v.length + "文字）");
}
