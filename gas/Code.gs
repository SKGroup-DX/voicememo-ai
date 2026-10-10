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
      case "resummarizeRecord":
        result = resummarizeRecord(body); break;
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
// person: 相手（相手の欄が完全に一致する記録だけ。要約画面の相手の名前から開いたとき）
// 記録が増えても重くならないよう、まず軽い列（ID〜状態）だけを読んでこの人の記録の行を選び、
// 要約や文字起こし（大きい列）は必要な行の分だけ読む。以前は毎回、全員分を読んでいた。
function getHistory(body) {
  const member = String(body.member || "");
  if (!member) return { success: false, error: "member required" };
  const limit  = Math.min(parseInt(body.limit) || 20, HISTORY_MAX_LIMIT);
  const offset = Math.max(parseInt(body.offset) || 0, 0);
  const type   = String(body.type || "");
  const person = String(body.person || "").trim();
  const terms  = String(body.q || "").toLowerCase().split(/[\s　]+/).filter(Boolean);

  const sheet = recordsSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return { success: true, records: [], total: 0, hasMore: false };
  const n = lastRow - HEADER_ROW;
  const heads = sheet.getRange(HEADER_ROW + 1, 1, n, COL.STATUS).getValues();
  let rows = [];
  for (let i = n - 1; i >= 0; i--) { // 新しい順
    const h = heads[i];
    if (!h[COL.ID - 1] && h[COL.ID - 1] !== 0) continue;
    if (readText_(h[COL.MEMBER - 1]) !== member) continue;
    if (person && readText_(h[COL.INTERVIEWEE - 1]) !== person) continue;
    rows.push(HEADER_ROW + 1 + i);
  }
  if (terms.length) rows = narrowBySearch_(sheet, rows, terms[0], n);

  // 種類や検索で絞り込むときは候補の行をすべて、絞り込まないときは表示するページの行だけを読む
  const filtering = !!type || terms.length > 0;
  const target = filtering ? rows : rows.slice(offset, offset + limit);
  const data = readRowsByNumber_(sheet, target, terms.length > 0);
  const matched = [];
  target.forEach(r => {
    const row = data[r];
    const rec = row ? rowToRecord(row) : null;
    if (!rec) return;
    if (type && !(rec.sections && rec.sections.meetingType === type)) return;
    if (terms.length) {
      const text = searchableText(rec, row);
      if (!terms.every(t => text.indexOf(t) !== -1)) return;
    }
    matched.push(rec);
  });

  if (!filtering) {
    return { success: true, records: matched, total: rows.length, hasMore: offset + limit < rows.length };
  }
  const total = matched.length;
  return {
    success: true,
    records: matched.slice(offset, offset + limit),
    total,
    hasMore: offset + limit < total
  };
}

// 1つ目の検索語を含む行を、スプレッドシートの検索機能（TextFinder）で探して候補を絞る
// （全員分の文字起こしを読まないように）。候補は後で要約・文字起こしを読んで確かめ直す。
// 検索機能が使えないときは絞らずに返す（遅くはなるが結果は同じ）。
function narrowBySearch_(sheet, rows, term, n) {
  if (!rows.length) return rows;
  try {
    const found = {};
    sheet.getRange(HEADER_ROW + 1, COL.INTERVIEWEE, n, COL.TRANSCRIPT - COL.INTERVIEWEE + 1)
      .createTextFinder(term).matchCase(false).findAll()
      .forEach(cell => { found[cell.getRow()] = true; });
    return rows.filter(r => found[r]);
  } catch (e) {
    console.warn("[getHistory] 検索機能が使えないため、絞らずに確かめます:", e.message);
    return rows;
  }
}

// 指定した行番号の行を読み、{ 行番号: 値の配列 } で返す。文字起こしの列は withTranscript の
// ときだけ読む（読まない場合は null）。行がまとまっていれば一度に、広く散らばった少ない行なら
// 1行ずつ読む（読む量を減らす）。
const ROW_BLOCK_MAX_SPAN = 1000;
function readRowsByNumber_(sheet, rowNums, withTranscript) {
  const out = {};
  if (!rowNums.length) return out;
  const read = (start, count) => {
    const before = sheet.getRange(start, 1, count, COL.TRANSCRIPT - 1).getValues();
    const trans = withTranscript ? sheet.getRange(start, COL.TRANSCRIPT, count, 1).getValues() : null;
    const after = sheet.getRange(start, COL.TRANSCRIPT + 1, count, NUM_COLS - COL.TRANSCRIPT).getValues();
    return before.map((r, i) => r.concat([trans ? trans[i][0] : null], after[i]));
  };
  const min = Math.min.apply(null, rowNums);
  const max = Math.max.apply(null, rowNums);
  const span = max - min + 1;
  if (span <= ROW_BLOCK_MAX_SPAN || rowNums.length > 20) {
    const block = read(min, span);
    rowNums.forEach(r => { out[r] = block[r - min]; });
  } else {
    rowNums.forEach(r => { out[r] = read(r, 1)[0]; });
  }
  return out;
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
  // ID の列だけを読んで行を探し、その行だけを読む（5秒おきに呼ばれるので軽くしておく）
  const results = {};
  const sheet = recordsSheet();
  const lastRow = sheet.getLastRow();
  const rowOf = {};
  if (lastRow > HEADER_ROW) {
    sheet.getRange(HEADER_ROW + 1, COL.ID, lastRow - HEADER_ROW, 1).getValues().forEach((r, i) => {
      const id = String(r[0]);
      if (wanted[id] && !rowOf[id]) rowOf[id] = HEADER_ROW + 1 + i;
    });
  }
  const data = readRowsByNumber_(sheet, Object.keys(rowOf).map(id => rowOf[id]), false);
  ids.forEach(id => { results[id] = rowOf[id] && data[rowOf[id]] ? statusOf_(data[rowOf[id]]) : { found: false }; });
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

  // 入力の誤りで断るとき（送り直しても同じ結果になる）は invalid を付ける。アプリは invalid の
  // ときだけ送信待ちから外し、それ以外の失敗（一時的なエラーなど）は後で自動で送り直す。
  const invalid = error => ({ success: false, invalid: true, error });
  if (!member) return invalid("member required");
  if (member.length > MAX_MEMBER_CHARS) return invalid("名前が長すぎます（" + MAX_MEMBER_CHARS + "文字まで）");
  if (!transcript) return invalid("文字起こしテキストがありません");
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    return invalid("文字数が上限（" + MAX_TRANSCRIPT_CHARS + "文字）を超えています");
  }

  // 記録の番号はアプリが送ってくる（送り直しても同じ番号）。保存した後に応答だけが
  // 届かずアプリが自動で送り直した場合に、同じ記録を2件作らないため。
  // 番号が付いていない・形が正しくない場合はこちらで作る。
  const clientId = String(body.id || "");
  const newId    = UUID_PATTERN.test(clientId) ? clientId.toLowerCase() : Utilities.getUuid();
  const recordDate = clientRecordedAt_(body.recordedAt) ||
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");

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

// 電波がなくて端末に保存しておき、後から自動で送った記録は、アプリが「要約する」を
// 押した日時（端末の時刻、"yyyy-MM-dd HH:mm:ss"）を送ってくる。その日時で記録する。
// 端末の時計のずれに備え、7日より前・未来（5分以上先）の日時は使わない。
const CLIENT_DATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function clientRecordedAt_(v) {
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return "";
  const t = recordMillis_(s);
  const now = Date.now();
  if (!t || t > now + 5 * 60 * 1000 || t < now - CLIENT_DATE_MAX_AGE_MS) return "";
  return s;
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
// 受け付けたばかりの記録は、アプリが本文付きで要約開始を送ってくる（下の processWithTranscript_）。
// その要約と二重にならないよう、定期実行は「押してからこの時間がたっていない、まだ誰も手を付けて
// いない記録」を拾わない。要約開始が届かなかった場合は、この時間の後に定期実行が拾う。
// その場での要約は、AIに100秒（最後の呼び出しの分を足しても約160秒）、受け付けの保存待ち20秒、
// ロック待ち30秒で終わるので、それより長くしておく。
const FRESH_GRACE_MS = 4 * 60 * 1000;
// その場での要約で、AIの呼び出しをやり直してよい時間（設定を変えてのやり直しも含めて通しで数える）
const SYNC_AI_BUDGET_MS = 100 * 1000;

function processRecord(body) {
  const id = body.id ? String(body.id) : "";
  if (!id) return { success: false, error: "id required" };
  const startedAt = Date.now();
  const auth = getGeminiAuth();
  const transcript = String(body.transcript || "").trim();
  if (transcript && transcript.length <= MAX_TRANSCRIPT_CHARS) return processWithTranscript_(id, transcript, auth, startedAt);
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
  const waitMs = Date.now() - startedAt;
  const aiStartedAt = Date.now();
  try {
    const sections = callGeminiSummarize(job.transcript, auth, syncPolicy_(), job.forceType);
    console.log("[processRecord] 要約にかかった時間:", ((Date.now() - aiStartedAt) / 1000).toFixed(1), "秒 ／ 文字数:", job.transcript.length, "／ 種別:", sections.meetingType);
    finishJob_(job, { sections, timing: makeTiming_(job.id, "その場", job.transcript.length, startedAt, waitMs, aiStartedAt) });
    return { success: true, id, status: "done", sections };
  } catch (e) {
    const timing = makeTiming_(job.id, "その場", job.transcript.length, startedAt, waitMs, aiStartedAt);
    if (e.permanent) {
      // やり直しても同じ結果になるもの（安全確認での拒否など）は、定期実行に回さず失敗にする
      console.warn("[processRecord] やり直しても結果が変わらないため失敗にする id:", id, e.message);
      finishJob_(job, { error: e.userMessage || GENERIC_ERROR_MESSAGE, timing });
      return { success: true, id, status: "error", error: e.userMessage || GENERIC_ERROR_MESSAGE };
    }
    console.warn("[processRecord] その場での要約をあきらめ、定期実行に任せる id:", id, e.message);
    finishJob_(job, { requeue: true, timing });
    return { success: true, id, status: "queued" };
  }
}

// 本文付きの要約開始（アプリが［要約する］で受け付けと同時に送る）。受け付けの保存を待たずに
// すぐAIを呼び、終わってから同じ記録に書き込む（以前は保存とその順番待ちを待ってから呼んでいた）。
// 受け付けた行は queued のまま（FRESH_GRACE_MS の間は定期実行が拾わない）なので、二重には要約しない。
// 書き込むのは、行の本文が送られてきた本文と同じで、まだ完了していない場合だけ。
function syncPolicy_() {
  return Object.assign({}, RETRY_POLICY_SYNC, { deadline: Date.now() + SYNC_AI_BUDGET_MS });
}

// 本文付きの要約開始を担当中という目印（同じ記録の要約開始が届き直しても、AIを二重に呼ばない）
const FAST_MARK_TTL_SEC = 300;

function processWithTranscript_(id, transcript, auth, startedAt) {
  // 届き直し（アプリの自動の送り直しなど）や、すでに要約が終わっている記録では、AIを呼ばない
  const cache = CacheService.getScriptCache();
  const markKey = "fast_" + id;
  const pre = withLock_(() => {
    if (cache.get(markKey)) return { status: "inProgress" };
    const values = readRowById_(id);
    const status = values ? String(values[COL.STATUS - 1] || "") : "";
    if (status === "done") return { status: "done", sections: stripTranscript(parseSections(values[COL.SECTIONS - 1])) };
    if (status === "processing") return { status: "processing" };
    cache.put(markKey, "1", FAST_MARK_TTL_SEC);
    return null;
  }, 10000);
  if (pre) {
    console.log("[processRecord] 本文付き id:", id, "AIは呼ばない（" + pre.status + "）");
    return Object.assign({ success: true, id }, pre);
  }
  try {
    return summarizeWithTranscript_(id, transcript, auth, startedAt);
  } finally {
    try {
      cache.remove(markKey);
    } catch (e) {}
  }
}

function summarizeWithTranscript_(id, transcript, auth, startedAt) {
  const aiStartedAt = Date.now();
  let sections = null;
  let failure = null;
  try {
    sections = callGeminiSummarize(transcript, auth, syncPolicy_(), "");
  } catch (e) {
    failure = e;
  }
  const aiEndedAt = Date.now();
  const timing = makeTiming_(id, "その場（本文付き）", transcript.length, startedAt, 0, aiStartedAt);
  // 受け付けの保存がまだなら待つ（AIを呼んでいる間に、ほとんどの場合は保存が済んでいる）
  const sheet = recordsSheet();
  const waitUntil = Date.now() + WAIT_FOR_SUBMIT_MS;
  while (findRecordRowById(sheet, id) < 0 && Date.now() < waitUntil) Utilities.sleep(500);
  timing.waitMs = Date.now() - aiEndedAt;
  let outcome;
  try {
    outcome = withLock_(() => {
      const row = findRecordRowById(sheet, id);
      if (row < 0) return { status: "skipped", note: "受け付けが見つからない" };
      const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
      const status = String(values[COL.STATUS - 1] || "");
      const summary = parseSections(values[COL.SECTIONS - 1]);
      if (status === "done") return { status: "done", sections: stripTranscript(summary), note: "完了済みのため書き込まず" };
      if (rowTranscript(values) !== transcript || (summary && summary.requestedType)) {
        // 本文が違う・種類の指定がある場合は、通常の流れ（定期実行など）に任せる
        return { status, note: "書き込まず（通常の流れに任せる）" };
      }
      if (sections) {
        sheet.getRange(row, COL.SECTIONS).setValue(JSON.stringify(sections));
        sheet.getRange(row, COL.STATUS).setValue("done");
        sheet.getRange(row, COL.PROCESS_ERROR).setValue("");
        recordTiming_(timing, values, "完了");
        return { status: "done", sections, note: "完了" };
      }
      if (failure.permanent && status === "queued") {
        const message = failure.userMessage || GENERIC_ERROR_MESSAGE;
        sheet.getRange(row, COL.STATUS).setValue("error");
        sheet.getRange(row, COL.PROCESS_ERROR).setValue(cellText_(message));
        recordTiming_(timing, values, "失敗");
        return { status: "error", error: message, note: "失敗として記録" };
      }
      // 一時的な失敗：処理開始時刻を入れて、定期実行がすぐ拾えるようにする（受け付け直後の待ちをやめる）
      if (status === "queued") sheet.getRange(row, COL.PROCESSING_STARTED_AT).setValue(new Date());
      recordTiming_(timing, values, "後回し");
      return { status, note: "定期実行に任せる" };
    }, 30000);
  } catch (e) {
    console.error("[processRecord] 結果を書き込めませんでした id:", id, e.message);
    // 受け付けが保存されたかどうか分からないので、アプリが「受け付け済み」と思わないようにする
    return { success: true, id, status: "unknown" };
  }
  console.log("[processRecord] 本文付き id:", id, "（" + outcome.note + "）AI", ((aiEndedAt - aiStartedAt) / 1000).toFixed(1), "秒 ／ 文字数:", transcript.length, failure ? "／ 失敗: " + failure.message : "");
  const res = { success: true, id, status: outcome.status };
  if (outcome.sections) res.sections = outcome.sections;
  if (outcome.error) res.error = outcome.error;
  return res;
}

// 定期実行（setupTriggersで1分おきに設定）。受け付け済みの記録を1件ずつ要約する。
// 複数件たまっていても、拾い始めるのは開始から1分まで（長引いた分は次の回に回す）。
function runPendingJobs() {
  const startedAt = Date.now();
  flushTimings_();
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
    const jobStartedAt = Date.now();
    const timing = () => makeTiming_(job.id, "定期実行", job.transcript.length, jobStartedAt, 0, jobStartedAt);
    try {
      if (!job.transcript) throw userError_("文字起こしテキストがありません", { permanent: true });
      console.log("[runPendingJobs] 要約開始 id:", job.id);
      const policy = Object.assign({}, RETRY_POLICY_BACKGROUND, {
        deadline: Math.min(Date.now() + RETRY_POLICY_BACKGROUND.budgetMs, runEnd)
      });
      const sections = callGeminiSummarize(job.transcript, auth, policy, job.forceType);
      const result = finishJob_(job, { sections, timing: timing() });
      console.log("[runPendingJobs] 完了 id:", job.id, "（" + result + "）", ((Date.now() - jobStartedAt) / 1000).toFixed(1) + "秒");
    } catch (e) {
      const result = finishJob_(job, { error: e.userMessage || GENERIC_ERROR_MESSAGE, timing: timing() });
      console.error("[runPendingJobs] 失敗 id:", job.id, e.message, "（" + result + "）");
    }
  }
}

// 要約待ち（queued）の行を探す（なければ-1）。受け付けたばかりで、アプリからの本文付きの
// 要約開始が担当している行（押してから FRESH_GRACE_MS 以内で、処理開始時刻が空）は飛ばす。
function findQueuedRow_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROW) return -1;
  const n = lastRow - HEADER_ROW;
  const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, n, 1).getValues();
  let dates = null;
  let starts = null;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    if (String(statuses[i][0]) !== "queued") continue;
    if (!dates) {
      dates = sheet.getRange(HEADER_ROW + 1, COL.DATE, n, 1).getValues();
      starts = sheet.getRange(HEADER_ROW + 1, COL.PROCESSING_STARTED_AT, n, 1).getValues();
    }
    const t = recordMillis_(dates[i][0]);
    if (!starts[i][0] && t && now - t < FRESH_GRACE_MS) continue;
    return HEADER_ROW + 1 + i;
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
    const prevSummary = parseSections(values[COL.SECTIONS - 1]);
    return {
      id: String(values[COL.ID - 1]),
      transcript: rowTranscript(values),
      // 「種類を直して要約し直す」で指定された種類（無ければAIが判定する）
      forceType: validMeetingType_(prevSummary && prevSummary.requestedType),
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
        recordTiming_(outcome.timing, values, "完了");
        return "完了";
      }
      const mine = status === "processing" && Math.abs(toMillis_(values[COL.PROCESSING_STARTED_AT - 1]) - job.token) < 1000;
      if (!mine) return "他の処理が担当中のため書き込まず";
      if (outcome.requeue) {
        sheet.getRange(row, COL.STATUS).setValue("queued");
        recordTiming_(outcome.timing, values, "後回し");
        return "要約待ちに戻した";
      }
      sheet.getRange(row, COL.STATUS).setValue("error");
      sheet.getRange(row, COL.PROCESS_ERROR).setValue(cellText_(outcome.error || GENERIC_ERROR_MESSAGE));
      recordTiming_(outcome.timing, values, "失敗");
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
    clearReapCount_(id);
    console.log("[retryRecord] 再受け付け完了 id:", id);
    return { success: true, status: "queued" };
  });
}

// ================================================================
// 種類（1on1／会議）を直して要約し直す
// ================================================================
// AIの判定した種類が違っていたときに、利用者が正しい種類を選んで要約し直す。
// 指定された種類は要約の列に requestedType として書いておき、要約待ち（queued）に
// 戻す。あとは通常の要約と同じ流れ（その場での要約・定期実行）で、その種類として
// 要約する。新しい要約ができるまでは前の要約を残しておく（失敗しても消えないように）。
function resummarizeRecord(body) {
  const id = body.id ? String(body.id) : "";
  const type = validMeetingType_(body.meetingType);
  if (!id) return { success: false, error: "id required" };
  if (!type) return { success: false, error: "種類の指定が正しくありません" };
  return withLock_(() => {
    const sheet = recordsSheet();
    const row = findRecordRowById(sheet, id);
    if (row < 0) return { success: false, error: "記録が見つかりません" };
    const values = sheet.getRange(row, 1, 1, NUM_COLS).getValues()[0];
    const status = String(values[COL.STATUS - 1] || "");
    if (status !== "done" && status !== "error") {
      return { success: false, error: "要約中です。終わってからもう一度お試しください。" };
    }
    if (!rowTranscript(values)) {
      return { success: false, error: "文字起こしが保存期間を過ぎて削除されているため、要約し直せません。" };
    }
    const summary = parseSections(values[COL.SECTIONS - 1]) || {};
    summary.requestedType = type;
    sheet.getRange(row, COL.SECTIONS).setValue(JSON.stringify(summary));
    sheet.getRange(row, COL.STATUS).setValue("queued");
    sheet.getRange(row, COL.PROCESS_ERROR).setValue("");
    clearReapCount_(id);
    console.log("[resummarizeRecord] 種類を指定して要約待ちに戻した id:", id, "種類:", type);
    return { success: true, status: "queued" };
  });
}

function validMeetingType_(v) {
  return v === "1on1" || v === "group" ? v : "";
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
    aiStats_.calls++;
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
    aiStats_.sleptMs += waitSec * 1000;
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
// thinkingLevel：モデルが答える前に考える量。少ないほど速い。スクリプトプロパティ
//   GEMINI_THINKING_LEVEL で変えられる（未設定なら "low"。"minimal" にできるかは、
//   エディタで testThinkingLevels を実行して速さを比べてから決める）。
// responseMimeType JSON：返答を必ずJSONにし、形式崩れによる失敗（＝後回し処理行き）を減らす。
// モデルやAPIの版によってはこれらの指定を受け付けず400になるため、その場合は外せる設定を
// 外して自動的にやり直す（要約自体は止めない）。受け付けないと分かった設定はスクリプト
// プロパティに覚えて、次からは最初から使わない（毎回、断られる呼び出しをはさまないように）。
//   NO_THINKING_<モデル名>：考える量の指定を受け付けない
//   NO_FAST_CONFIG_<モデル名>：JSONの指定も含めて受け付けない
// 返答の項目まで厳密に決める指定（responseSchema）は使わない。Geminiは項目を名前順に並べて
// 書くため、種類（meetingType）を決める前に中身を書き始めてしまうため。
const DEFAULT_THINKING_LEVEL = "low";
const THINKING_LEVELS = ["minimal", "low", "medium", "high"];
const MIME_CONFIG_ERROR_PATTERN = /response_?mime|mime_?type|generation_?config|unknown name/i;

// 1回の要約での、AIの呼び出し回数・混雑で待った時間・使った設定（計測用）
let aiStats_ = { calls: 0, sleptMs: 0, config: "" };

function thinkingLevel_() {
  const v = prop_("GEMINI_THINKING_LEVEL").trim().toLowerCase();
  return THINKING_LEVELS.indexOf(v) !== -1 ? v : DEFAULT_THINKING_LEVEL;
}

// forceType: "1on1" | "group" を渡すと、AIに判定させずにその種類として要約する
// thinkingOverride: 考える量を指定して呼ぶ（testThinkingLevels 用）
function callGeminiSummarize(transcript, auth, policy, forceType, thinkingOverride) {
  const model = geminiModel();
  const url = GEMINI_API_BASE + model + ":generateContent";
  const prompt = getDefaultSystemPrompt(transcript.length, forceType) + "\n\n【文字起こし内容】\n" + transcript;
  aiStats_ = { calls: 0, sleptMs: 0, config: "" };

  const noFastKey = "NO_FAST_CONFIG_" + model;
  const noThinkingKey = "NO_THINKING_" + model;
  let json = !prop_(noFastKey);
  let levels = [];
  if (json && !prop_(noThinkingKey)) {
    const level = thinkingOverride || thinkingLevel_();
    // "low" 以外を指定していて断られたら、"low" でやり直す
    levels = level === DEFAULT_THINKING_LEVEL ? [level] : [level, DEFAULT_THINKING_LEVEL];
  }
  let jsonText;
  for (;;) {
    const config = { temperature: 0.3, maxOutputTokens: 32768 };
    if (json) config.responseMimeType = "application/json";
    if (levels.length) config.thinkingConfig = { thinkingLevel: levels[0] };
    aiStats_.config = "考える量:" + (levels.length ? levels[0] : "指定なし") + (json ? "／JSON" : "");
    try {
      const payload = { contents: [{ parts: [{ text: prompt }] }], generationConfig: config };
      jsonText = extractGeminiText(fetchGeminiWithRetry(url, payload, "要約", auth, policy), "要約");
      break;
    } catch (e) {
      if (e.apiCode !== 400 || (!json && !levels.length)) throw e;
      const msg = e.apiMessage || "";
      console.warn("[要約] 設定が受け付けられなかったため、設定を変えてやり直します:", msg);
      if (levels.length && /thinking/i.test(msg)) {
        levels.shift();
        if (!levels.length) {
          setProp_(noThinkingKey, "1");
          console.log("[要約] " + model + " では次から考える量を指定しません");
        }
      } else if (json && MIME_CONFIG_ERROR_PATTERN.test(msg)) {
        json = false;
        levels = [];
        setProp_(noFastKey, "1");
        console.log("[要約] " + model + " では次から高速化の設定を使いません");
      } else {
        // 原因が分からない400：今回だけ設定なしでやり直す（一時的な別の原因で、ずっと遅い設定に
        // ならないよう、覚えない）
        json = false;
        levels = [];
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
  // 種類を指定したときは、AIの返した種類にかかわらず指定どおりにする
  if (forceType && parsed && typeof parsed === "object") {
    parsed.meetingType = forceType;
    if (forceType === "group") delete parsed.analysis;
  }
  // AIの短い形の返答を保存する形に直し、形を確かめて整える（崩れた形のまま保存すると、
  // 検索や画面の表示が壊れるため）。文字起こしはTRANSCRIPT列にあるので、要約には入れない。
  return normalizeSummary_(expandSummary_(parsed));
}

// AIには見出しの名前や絵文字を書かせず、短い名前（goal など）で項目だけを返させる
// （書く量が減るほど速く終わる）。ここで保存する形（見出しの名前・絵文字付き）に直す。
// 以前の形（sections の配列）で返ってきた場合はそのまま使う。
const SUMMARY_TEMPLATES = {
  "1on1": [["goal", "今日のゴール", "🎯"], ["voice", "本人の声", "💬"], ["action", "アクション", "✅"], ["follow", "フォロー事項", "📅"]],
  group: [["purpose", "目的・アジェンダ", "🎯"], ["decisions", "主な決定事項", "✅"], ["todos", "担当者ごとのToDo", "📋"], ["pending", "保留事項・継続協議テーマ", "⏳"]]
};
function expandSummary_(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw.sections)) return raw;
  const type = raw.meetingType === "group" || raw.meetingType === "1on1"
    ? raw.meetingType
    : (raw.goal || raw.voice ? "1on1" : "group");
  const out = {
    meetingType: type,
    sections: SUMMARY_TEMPLATES[type].map(t => {
      const v = raw[t[0]];
      const items = Array.isArray(v) ? v : (v == null ? [] : [v]);
      return { key: t[0], label: t[1], emoji: t[2], items: items.length ? items : ["特になし"] };
    })
  };
  const a = raw.analysis;
  if (type === "1on1" && a && typeof a === "object") {
    out.analysis = {
      speakingRatio: { self: a.self, other: a.other },
      listeningScore: a.listening,
      listeningComment: a.comment,
      openQuestionRatio: a.open
    };
  }
  return out;
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
function getDefaultSystemPrompt(transcriptLength, forceType) {
  const step1 = forceType
    ? `【ステップ1：会議種別】
この録音は、利用者の指定により「${forceType === "1on1" ? "1on1（1対1の面談・個別打ち合わせ）" : "group（複数人が参加する会議）"}」として扱ってください。
判定はせず、meetingTypeは必ず"${forceType}"にしてください。`
    : `【ステップ1：会議種別の自動判定】
発言者の人数や対話スタイル（一対一の対話か、複数人による議論・報告か）から、この録音が
「1on1（1対1の面談・個別打ち合わせ）」か「group（複数人が参加する会議）」かを判定してください。`;
  return `あなたは優秀な議事録・要約AIです。文字起こしを分析し、以下のステップに従ってください。

${step1}

【ステップ2：判定結果に応じた出力】
以下のJSONだけを出力してください（説明文やコードブロックは不要）。

■ meetingTypeが"1on1"の場合
{"meetingType":"1on1","goal":["..."],"voice":["..."],"action":["..."],"follow":["..."],"analysis":{"self":<数値>,"other":<数値>,"listening":<数値>,"comment":"...","open":<数値>}}
- goal：今日のゴール／voice：本人の声／action：アクション／follow：フォロー事項

■ meetingTypeが"group"の場合（analysisは出力しない）
{"meetingType":"group","purpose":["..."],"decisions":["..."],"todos":["<担当者名>：<タスク内容>（期日：<期日、不明なら未定>）"],"pending":["..."]}
- purpose：目的・アジェンダ／decisions：主な決定事項／todos：担当者ごとのToDo／pending：保留事項・継続協議テーマ

【各項目共通】${itemCountRule_(transcriptLength)}情報がない場合は["特になし"]

【analysis】（1on1の場合のみ。いずれも0〜100の数値）
- self：進行役の発話割合、other：相手の発話割合（self+other=100）
- listening：傾聴度スコア。相手の発言を受けて深掘りする質問ができているか、話を遮っていないか等から算出
- comment：傾聴度についての一言コメント（30文字程度）
- open：オープンクエスチョンの割合。「はい/いいえ」で終わる質問ではなく、「なぜ」「どう思う」等の深掘りする質問の割合
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
  ensurePurgeTrigger_();
}

// 古い文字起こしの自動削除は、毎日の定期実行（setupTriggersで作る）で動く。GASを更新した
// ときに setupTriggers の実行を忘れても止まらないよう、無ければここで作る（確認は6時間に1回）。
function ensurePurgeTrigger_() {
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get("purgeTriggerChecked")) return;
    const has = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === "purgeOldTranscripts");
    if (!has) {
      ScriptApp.newTrigger("purgeOldTranscripts").timeBased().everyDays(1).atHour(3).create();
      console.log("[warmup] 文字起こしの自動削除の定期実行が無かったため作りました");
    }
    cache.put("purgeTriggerChecked", "1", 6 * 60 * 60);
  } catch (e) {
    console.warn("[warmup] 自動削除の定期実行を確認できませんでした:", e.message);
  }
}

// 要約中にGASの実行時間上限などで異常終了すると、行が"processing"のまま
// 取り残されることがある。一定時間"processing"のままの行を"queued"に戻し、
// 次回の定期実行で拾い直す。ただし同じ記録が何度も止まる場合は、無料枠を使い続けない
// よう、戻すのは MAX_REAPS 回までにして、その次は失敗にする（［再試行］でやり直せる）。
// 読んでから書くまでの間に行がずれないよう、ロックの中で行う。
const MAX_REAPS = 2;
const REAP_COUNT_TTL_SEC = 6 * 60 * 60;
const REAP_GIVE_UP_MESSAGE = "要約が時間内に終わりませんでした。［再試行］でやり直せます（録音が長い場合は分けて送ってください）。";

function reapStaleProcessing() {
  try {
    withLock_(() => {
      const sheet = recordsSheet();
      const lastRow = sheet.getLastRow();
      if (lastRow <= HEADER_ROW) return;
      const numRows = lastRow - HEADER_ROW;
      const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, numRows, 1).getValues();
      if (!statuses.some(s => String(s[0]) === "processing")) return;
      const startedAts = sheet.getRange(HEADER_ROW + 1, COL.PROCESSING_STARTED_AT, numRows, 1).getValues();
      const ids = sheet.getRange(HEADER_ROW + 1, COL.ID, numRows, 1).getValues();
      const thresholdMs = STALE_PROCESSING_MINUTES * 60 * 1000;
      const now = Date.now();
      let reverted = 0;
      let gaveUp = 0;
      for (let i = 0; i < numRows; i++) {
        if (String(statuses[i][0]) !== "processing") continue;
        const startedMs = toMillis_(startedAts[i][0]);
        if (startedMs && now - startedMs <= thresholdMs) continue;
        const row = HEADER_ROW + 1 + i;
        if (bumpReapCount_(String(ids[i][0])) > MAX_REAPS) {
          sheet.getRange(row, COL.STATUS).setValue("error");
          sheet.getRange(row, COL.PROCESS_ERROR).setValue(REAP_GIVE_UP_MESSAGE);
          gaveUp++;
        } else {
          sheet.getRange(row, COL.STATUS).setValue("queued");
          reverted++;
        }
      }
      if (reverted > 0) console.log("[reapStaleProcessing] " + reverted + "件を再投入しました");
      if (gaveUp > 0) console.warn("[reapStaleProcessing] 何度も止まった " + gaveUp + "件を失敗にしました");
    });
  } catch (e) {
    console.warn("[reapStaleProcessing] 今回は見送り:", e.message);
  }
}

// 止まった処理を拾い直した回数（記録ごと・6時間で忘れる）
function bumpReapCount_(id) {
  try {
    const cache = CacheService.getScriptCache();
    const key = "reaps_" + id;
    const n = (parseInt(cache.get(key), 10) || 0) + 1;
    cache.put(key, String(n), REAP_COUNT_TTL_SEC);
    return n;
  } catch (e) {
    return 1;
  }
}
function clearReapCount_(id) {
  try {
    CacheService.getScriptCache().remove("reaps_" + id);
  } catch (e) {}
}

// ================================================================
// 古い文字起こしの自動削除（毎日の定期実行）
// ================================================================
// 1on1などの機密性に配慮し、一定日数（スクリプトプロパティ TRANSCRIPT_RETENTION_DAYS、
// 未設定なら90日。受け付けた日時から数える）を過ぎた記録は、文字起こしの本文だけを
// 消して要約は残す。0 を設定すると消さない。
// 要約待ち・要約中の記録は、要約に本文が要るので消さない。失敗した記録は消す。
// 古い記録には要約の列の中にも文字起こし（_transcript）が残っていることがあるので、それも消す。
// 対象の行はロックの外で探し、ロックの中では番号（ID）と状態を確かめ直してから消す
// （本文の列は大きいので、読んでいる間ほかの処理を待たせないように）。
const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 90;
const PURGE_STATUSES = ["done", "error"];

function transcriptRetentionDays_() {
  const v = prop_("TRANSCRIPT_RETENTION_DAYS").trim();
  if (v === "") return DEFAULT_TRANSCRIPT_RETENTION_DAYS;
  const n = parseInt(v, 10);
  return isFinite(n) && n >= 0 ? n : DEFAULT_TRANSCRIPT_RETENTION_DAYS;
}

// 保存期間を過ぎて、文字起こしを消す（消した）記録か
function transcriptExpired_(row) {
  const days = transcriptRetentionDays_();
  if (!days) return false;
  if (PURGE_STATUSES.indexOf(String(row[COL.STATUS - 1])) === -1) return false;
  const t = recordMillis_(row[COL.DATE - 1]);
  return !!t && t < Date.now() - days * 24 * 60 * 60 * 1000;
}

function purgeOldTranscripts() {
  const days = transcriptRetentionDays_();
  if (!days) {
    console.log("[purgeOldTranscripts] TRANSCRIPT_RETENTION_DAYS が0のため、消さずに終了");
    return;
  }
  const targets = {};
  let found = 0;
  readAllRows().forEach(row => {
    if (!transcriptExpired_(row)) return;
    const oldCopy = String(row[COL.SECTIONS - 1] || "").indexOf('"_transcript"') !== -1;
    if (!row[COL.TRANSCRIPT - 1] && !oldCopy) return;
    targets[String(row[COL.ID - 1])] = true;
    found++;
  });
  if (!found) return;
  try {
    withLock_(() => {
      const sheet = recordsSheet();
      const lastRow = sheet.getLastRow();
      if (lastRow <= HEADER_ROW) return;
      const n = lastRow - HEADER_ROW;
      const ids = sheet.getRange(HEADER_ROW + 1, COL.ID, n, 1).getValues();
      const statuses = sheet.getRange(HEADER_ROW + 1, COL.STATUS, n, 1).getValues();
      const summaries = sheet.getRange(HEADER_ROW + 1, COL.SECTIONS, n, 1).getValues();
      let purged = 0;
      for (let i = 0; i < n; i++) {
        if (!targets[String(ids[i][0])]) continue;
        // 探した後に「要約し直す」などで要約待ちになった記録は消さない
        if (PURGE_STATUSES.indexOf(String(statuses[i][0])) === -1) continue;
        const row = HEADER_ROW + 1 + i;
        // 消す行だけを書き換える（列全体を書き戻すと、先頭が - などの本文が数式扱いになるため）
        sheet.getRange(row, COL.TRANSCRIPT).setValue("");
        const summary = parseSections(summaries[i][0]);
        if (summary && typeof summary === "object" && "_transcript" in summary) {
          delete summary._transcript;
          sheet.getRange(row, COL.SECTIONS).setValue(JSON.stringify(summary));
        }
        purged++;
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

// 古い記録には、要約の中に文字起こし(_transcript)が残っていることがあるので取り除いて返す。
// 「要約し直す」で指定した種類（requestedType）もアプリには不要なので外す。
function stripTranscript(sections) {
  if (!sections || typeof sections !== "object") return sections;
  const copy = Object.assign({}, sections);
  delete copy._transcript;
  delete copy.requestedType;
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
      // 文字起こしの列を読んでいない場合（null）は、保存期間を過ぎていなければあるものとして扱う
      // （受け付け時に必ず保存し、消すのは保存期間を過ぎたときだけのため）
      hasTranscript: row[COL.TRANSCRIPT - 1] === null ? !transcriptExpired_(row) : !!rowTranscript(row),
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

// ================================================================
// 計測（要約1件ごとの所要時間を「計測」シートに残す）
// ================================================================
// どこで時間がかかっているか（ムラの原因）を数字で確かめるため、要約1件ごとに秒数を記録する。
// 要約の結果を返すのを遅らせないよう、その場ではキャッシュにためておき、1分おきの定期実行
// （runPendingJobs）がまとめてシートに書く。
const TIMING_SHEET = "計測";
const TIMING_HEADERS = ["日時", "ID", "経路", "文字数", "モデル", "設定", "保存・順番待ち(秒)", "AI(秒)", "AI呼び出し回数", "混雑で待った(秒)", "この処理の合計(秒)", "押してから完了まで(秒)", "結果"];
const TIMING_CACHE_KEY = "timings";

// AIの呼び出しが終わった直後に作る
function makeTiming_(id, route, chars, startedAt, waitMs, aiStartedAt) {
  return {
    id, route, chars, startedAt, waitMs,
    aiMs: Date.now() - aiStartedAt,
    calls: aiStats_.calls,
    sleptMs: aiStats_.sleptMs,
    config: aiStats_.config,
    model: geminiModel()
  };
}

// 結果を書き込んだときに、ロックの中で呼ぶ（キャッシュの読み書きが重ならないように）
function recordTiming_(t, values, result) {
  if (!t) return;
  try {
    const sec = ms => Math.round(ms / 100) / 10;
    const now = Date.now();
    // 「押してから」は受け付けたばかりの記録だけ（やり直しなど、日時が古い記録は空にする）
    const pressed = recordMillis_(values[COL.DATE - 1]);
    const sincePressed = pressed && now - pressed < 60 * 60 * 1000 ? sec(now - pressed) : "";
    const row = [
      Utilities.formatDate(new Date(now), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss"),
      t.id, t.route, t.chars, t.model, t.config,
      sec(t.waitMs), sec(t.aiMs), t.calls, sec(t.sleptMs), sec(now - t.startedAt), sincePressed, result
    ];
    const cache = CacheService.getScriptCache();
    const list = JSON.parse(cache.get(TIMING_CACHE_KEY) || "[]");
    list.push(row);
    cache.put(TIMING_CACHE_KEY, JSON.stringify(list.slice(-200)), 6 * 60 * 60);
  } catch (e) {
    console.warn("[計測] 記録できませんでした:", e.message);
  }
}

function flushTimings_() {
  try {
    const cache = CacheService.getScriptCache();
    if (!cache.get(TIMING_CACHE_KEY)) return;
    withLock_(() => {
      const list = JSON.parse(cache.get(TIMING_CACHE_KEY) || "[]");
      if (list.length) {
        const sheet = SS().getSheetByName(TIMING_SHEET) || createTimingSheet_();
        sheet.getRange(sheet.getLastRow() + 1, 1, list.length, TIMING_HEADERS.length).setValues(list);
      }
      cache.remove(TIMING_CACHE_KEY);
    }, 5000);
  } catch (e) {
    console.warn("[計測] シートに書けませんでした（次回に再実行）:", e.message);
  }
}

function createTimingSheet_() {
  const sheet = SS().insertSheet(TIMING_SHEET);
  sheet.getRange(1, 1, 1, TIMING_HEADERS.length).setValues([TIMING_HEADERS]).setFontWeight("bold").setBackground("#E8EAF6");
  sheet.setFrozenRows(1);
  return sheet;
}

// ================================================================
// 考える量ごとの速さの比較（Apps Scriptエディタから手動実行）
// ================================================================
// 同じ例文を、考える量（minimal・low）を変えて2回ずつ要約し、かかった時間と結果を表示する。
// minimal の方が速く、要約の中身にも問題がなければ、スクリプトプロパティ
// GEMINI_THINKING_LEVEL に minimal を設定する。AIを4回呼ぶ（無料枠の回数を少し使う）。
// 記録は作らない。
const SAMPLE_TRANSCRIPT = [
  "今日は来期の役割について話したいと思います。最近の仕事はどうですか。",
  "そうですね、資料作りが多くて、正直少し負担に感じています。お客様との打ち合わせにはもっと出たいです。",
  "なるほど。打ち合わせではどんな役割を担当したいですか。",
  "説明役をやってみたいです。製品のことはだいぶ分かってきたので。",
  "いいですね。では次の案件で冒頭の説明を任せます。資料作りは集計のテンプレートを一緒に作って、時間を減らしましょう。",
  "ありがとうございます。テンプレートは水曜の15時からでどうでしょうか。",
  "大丈夫です。来月の面談で、説明役をやってみてどうだったかを聞かせてください。"
].join("\n");

function testThinkingLevels() {
  let auth;
  try {
    auth = getGeminiAuth();
  } catch (e) {
    console.log("✗ 設定エラー:", e.message);
    return;
  }
  console.log("モデル:", geminiModel(), "／今の設定:", thinkingLevel_());
  ["minimal", "low"].forEach(level => {
    for (let i = 1; i <= 2; i++) {
      const t0 = Date.now();
      try {
        const s = callGeminiSummarize(SAMPLE_TRANSCRIPT, auth, RETRY_POLICY_SYNC, "", level);
        console.log(level + " " + i + "回目: " + ((Date.now() - t0) / 1000).toFixed(1) + "秒（" + aiStats_.config + "、呼び出し" + aiStats_.calls + "回）→ " +
          s.meetingType + "／" + s.sections.map(x => x.label + ":" + x.items.join("・")).join(" ｜ "));
      } catch (e) {
        console.log(level + " " + i + "回目: 失敗 → " + e.message);
      }
    }
  });
  console.log("※ 設定が「考える量:low」と表示された minimal の回は、このモデルが minimal を受け付けなかったことを表します");
}
