// 要約の項目数と、古い文字起こしの自動削除を確かめる
// 実行: node tests/gas_retention.test.js
const fs = require("fs");
const code = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../gas/Code.gs"), "utf8");
let rows = [["ID","日時","名前","相手","状態","要約","文字起こし","エラー","処理開始時刻"]];
const sheet = {
  getLastRow: () => rows.length, getLastColumn: () => 9, getMaxRows: () => 1000,
  getRange: (r, c, nr = 1, nc = 1) => ({
    getValues: () => rows.slice(r - 1, r - 1 + nr).map(row => { const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] ?? ""); return o; }),
    getValue: () => (rows[r - 1] || [])[c - 1] ?? "",
    setValue: v => { rows[r - 1][c - 1] = v; },
    setValues: () => { throw new Error("列全体の書き戻しは使わない"); },
  }),
  appendRow: a => rows.push(a.slice()),
};
const props = { APP_PASSCODE: "k", GCP_PROJECT_ID: "p" };
let sentPrompt = "";
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, getName: () => "s" }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  Utilities: { sleep() {}, getUuid: () => "x", formatDate: () => "2026-10-06 10:00:00" },
  Session: { getScriptTimeZone: () => "Asia/Tokyo" },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  ScriptApp: { getOAuthToken: () => "t" },
  UrlFetchApp: { fetch: (u, o) => { sentPrompt = JSON.parse(o.payload).contents[0].parts[0].text; return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ meetingType: "1on1", sections: [{ label: "g", items: ["a"] }] }) }] } }] }) }; } },
  console: { log() {}, warn() {}, error() {} },
};
const load = () => new Function(...Object.keys(ctx), code + "\nreturn { doPost, purgeOldTranscripts, getDefaultSystemPrompt };")(...Object.values(ctx));
const call = b => JSON.parse(load().doPost({ postData: { contents: JSON.stringify({ key: "k", ...b }) } }).s);
const ok = (c, m) => { console.log((c ? "OK  " : "NG  ") + m); if (!c) process.exitCode = 1; };
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");

// 長さに応じた項目数
call({ action: "submitTranscript", id: uuid(1), member: "m", transcript: "あ".repeat(500) }); call({ action: "processRecord", id: uuid(1) });
ok(sentPrompt.includes("各2〜4項目。") && !sentPrompt.includes("${"), "短い文字起こしは各2〜4項目");
call({ action: "submitTranscript", id: uuid(2), member: "m", transcript: "あ".repeat(6000) }); call({ action: "processRecord", id: uuid(2) });
ok(sentPrompt.includes("各3〜5項目"), "中くらい（4千文字以上）は各3〜5項目");
call({ action: "submitTranscript", id: uuid(3), member: "m", transcript: "あ".repeat(20000) }); call({ action: "processRecord", id: uuid(3) });
ok(sentPrompt.includes("各4〜7項目") && sentPrompt.includes("漏れなく"), "長い（1万2千文字以上）は各4〜7項目・決定事項とToDoは漏れなく");
ok(load().getDefaultSystemPrompt().includes("各2〜4項目。"), "長さを渡さない呼び出しは従来どおり");

// 古い文字起こしの自動削除
const day = 24 * 60 * 60 * 1000;
rows = [rows[0],
  ["old-done", new Date(Date.now() - 100 * day), "m", "", "done", "{}", "古い本文", "", ""],
  ["old-done-str", "2026-01-01 09:00:00", "m", "", "done", "{}", "文字で入った日時の古い本文", "", ""],
  ["old-error", new Date(Date.now() - 100 * day), "m", "", "error", "", "失敗した古い本文", "x", ""],
  ["old-queued", new Date(Date.now() - 100 * day), "m", "", "queued", "", "要約待ちの古い本文", "", ""],
  ["new-done", new Date(Date.now() - 10 * day), "m", "", "done", "{}", "新しい本文", "", ""],
  ["old-dash", new Date(Date.now() - 100 * day), "m", "", "done", "{}", "'- 議題", "", ""],
  ["old-copy", new Date(Date.now() - 100 * day), "m", "", "done", JSON.stringify({ meetingType: "1on1", sections: [{ label: "g", items: ["a"] }], _transcript: "要約の中の古い本文" }), "", "", ""],
];
load().purgeOldTranscripts();
const t = id => rows.find(r => r[0] === id)[6];
ok(t("old-done") === "" && t("old-done-str") === "" && t("old-dash") === "", "90日より前の完了済みの文字起こしを消す（日時が文字でも）");
ok(t("old-error") === "", "失敗した古い記録の文字起こしも消す");
ok(t("old-queued") !== "", "要約待ちの記録は、要約に要るので消さない");
const copy = JSON.parse(rows.find(r => r[0] === "old-copy")[5]);
ok(!("_transcript" in copy) && copy.sections[0].items[0] === "a", "要約の列に残っていた古い文字起こし（_transcript）も消す（要約は残す）");
ok(t("new-done") === "新しい本文", "90日以内の記録は消さない");
ok(rows.find(r => r[0] === "old-done")[5] === "{}", "要約は残す");
const h = call({ action: "getHistory", member: "m" });
ok(h.records.find(r => r.id === "old-done").hasTranscript === false && h.records.find(r => r.id === "new-done").hasTranscript === true, "一覧では、保存期間を過ぎた記録を「文字起こしなし」として返す（本文の列は読まない）");
ok(call({ action: "getTranscript", id: "old-done" }).transcript === "", "消した記録の文字起こしは空で返る");
rows.find(r => r[0] === "new-done")[1] = new Date(Date.now() - 40 * day);
props.TRANSCRIPT_RETENTION_DAYS = "30"; load().purgeOldTranscripts();
ok(t("new-done") === "", "日数はスクリプトプロパティで変えられる（30日）");
rows.push(["older", new Date(Date.now() - 400 * day), "m", "", "done", "{}", "残したい本文", "", ""]);
props.TRANSCRIPT_RETENTION_DAYS = "0"; load().purgeOldTranscripts();
ok(t("older") === "残したい本文", "0にすると消さない");
