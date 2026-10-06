// 種類を直して要約し直す・止まった処理の打ち切り・送信待ちの日時・自動削除の定期実行の確認
// 実行: node tests/gas_features.test.js
const fs = require("fs");
const code = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../gas/Code.gs"), "utf8");
let rows = [["ID", "日時", "名前", "相手", "状態", "要約", "文字起こし", "エラー", "処理開始時刻"]];
const sheet = {
  getLastRow: () => rows.length, getLastColumn: () => 9, getMaxRows: () => 1000,
  getRange: (r, c, nr = 1, nc = 1) => ({
    getValues: () => rows.slice(r - 1, r - 1 + nr).map(row => { const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] ?? ""); return o; }),
    getValue: () => (rows[r - 1] || [])[c - 1] ?? "",
    setValue: v => { rows[r - 1][c - 1] = v; },
  }),
  appendRow: a => rows.push(a.slice()),
};
const props = { APP_PASSCODE: "k", GCP_PROJECT_ID: "p" };
const cache = {};
let triggers = [];
let reply = null;
let sentPrompt = "";
const p2 = n => String(n).padStart(2, "0");
const local = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const summaryReply = obj => ({ getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
// 「計測」シートなど、records 以外のシート
const extraSheets = {};
const extraSheet = () => { const data = []; return { data, getLastRow: () => data.length, setFrozenRows() {}, getRange: (r, c, nr = 1, nc = 1) => { const rg = { setValues: v => { v.forEach((row, i) => { data[r - 1 + i] = row.slice(); }); return rg; }, setFontWeight: () => rg, setBackground: () => rg }; return rg; } }; };
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => n === "records" ? sheet : (extraSheets[n] || null), insertSheet: n => (extraSheets[n] = extraSheet()), getName: () => "s" }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
  Utilities: { sleep() {}, getUuid: () => "x", formatDate: d => local(d) },
  Session: { getScriptTimeZone: () => "Asia/Tokyo" },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  ScriptApp: {
    getOAuthToken: () => "t",
    getProjectTriggers: () => triggers.map(h => ({ getHandlerFunction: () => h })),
    newTrigger: h => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => triggers.push(h) }) }) }) }),
  },
  UrlFetchApp: {
    fetch: (u, o) => {
      sentPrompt = JSON.parse(o.payload).contents[0].parts[0].text;
      if (reply) { const r = reply; reply = null; return r; }
      return summaryReply({ meetingType: "1on1", sections: [{ label: "今日のゴール", items: ["1on1の要約"] }], analysis: { listeningScore: 80 } });
    }
  },
  console: { log() {}, warn() {}, error() {} },
};
const load = () => new Function(...Object.keys(ctx), code + "\nreturn { doPost, warmup, runPendingJobs };")(...Object.values(ctx));
const call = b => JSON.parse(load().doPost({ postData: { contents: JSON.stringify({ key: "k", ...b }) } }).s);
const ok = (c, m) => { console.log((c ? "OK  " : "NG  ") + m); if (!c) process.exitCode = 1; };
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const row = id => rows.find(r => r[0] === id);
const summaryOf = id => JSON.parse(row(id)[5]);

// --- 種類を直して要約し直す ---
let id = uuid(1);
call({ action: "submitTranscript", id, member: "m", transcript: "本文1" });
call({ action: "processRecord", id });
ok(row(id)[4] === "done" && summaryOf(id).meetingType === "1on1", "（準備）1on1として要約された");
let r = call({ action: "resummarizeRecord", id, meetingType: "group" });
ok(r.success && row(id)[4] === "queued" && summaryOf(id).requestedType === "group" && summaryOf(id).sections[0].items[0] === "1on1の要約", "要約し直しを受け付けると要約待ちに戻し、前の要約は残す");
ok(call({ action: "getHistory", member: "m" }).records[0].sections.requestedType === undefined, "指定した種類（requestedType）はアプリに返さない");
reply = summaryReply({ meetingType: "1on1", sections: [{ label: "主な決定事項", items: ["会議の要約"] }], analysis: { listeningScore: 50 } });
call({ action: "processRecord", id });
let s = summaryOf(id);
ok(sentPrompt.includes('meetingTypeは必ず"group"') && !sentPrompt.includes("自動判定"), "指定した種類として要約するようAIに伝える");
ok(row(id)[4] === "done" && s.meetingType === "group" && !s.analysis && !s.requestedType && s.sections[0].items[0] === "会議の要約", "AIが違う種類を返しても指定どおりにし、会議では分析を外す");

reply = { getResponseCode: () => 200, getContentText: () => JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }) };
call({ action: "resummarizeRecord", id, meetingType: "1on1" });
call({ action: "processRecord", id });
ok(row(id)[4] === "error" && summaryOf(id).sections[0].items[0] === "会議の要約", "要約し直しに失敗しても前の要約は消えない");
call({ action: "retryRecord", id });
call({ action: "processRecord", id });
ok(row(id)[4] === "done" && summaryOf(id).meetingType === "1on1" && sentPrompt.includes('meetingTypeは必ず"1on1"'), "失敗後の［再試行］でも指定した種類で要約する");

row(id)[4] = "processing";
ok(call({ action: "resummarizeRecord", id, meetingType: "group" }).success === false && row(id)[4] === "processing", "要約中の記録は要約し直さない");
row(id)[4] = "done";
ok(call({ action: "resummarizeRecord", id, meetingType: "meeting" }).success === false, "種類の指定が正しくなければ断る");
row(id)[6] = "";
r = call({ action: "resummarizeRecord", id, meetingType: "group" });
ok(r.success === false && /保存期間/.test(r.error) && row(id)[4] === "done", "文字起こしが消えた記録は要約し直せない");

// --- 何度も止まる処理の打ち切り ---
id = uuid(2);
call({ action: "submitTranscript", id, member: "m", transcript: "本文2" });
const stall = () => { row(id)[4] = "processing"; row(id)[8] = new Date(Date.now() - 11 * 60 * 1000); load().warmup(); };
stall(); ok(row(id)[4] === "queued", "止まった処理の1回目は要約待ちに戻す");
stall(); ok(row(id)[4] === "queued", "2回目も要約待ちに戻す");
stall(); ok(row(id)[4] === "error" && /時間内に終わりませんでした/.test(row(id)[7]), "3回目は失敗にして、無料枠を使い続けない");
call({ action: "retryRecord", id });
stall(); ok(row(id)[4] === "queued", "［再試行］すると数え直す");

// --- 送信待ちから送った記録の日時 ---
const twoHoursAgo = local(new Date(Date.now() - 2 * 60 * 60 * 1000));
call({ action: "submitTranscript", id: uuid(3), member: "m", transcript: "本文3", recordedAt: twoHoursAgo });
ok(row(uuid(3))[1] === twoHoursAgo, "アプリが送った「要約する」を押した日時で記録する");
call({ action: "submitTranscript", id: uuid(4), member: "m", transcript: "本文4", recordedAt: local(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)) });
call({ action: "submitTranscript", id: uuid(5), member: "m", transcript: "本文5", recordedAt: local(new Date(Date.now() + 60 * 60 * 1000)) });
call({ action: "submitTranscript", id: uuid(6), member: "m", transcript: "本文6", recordedAt: "=NOW()" });
const near = v => Math.abs(new Date(v.replace(" ", "T")).getTime() - Date.now()) < 60 * 1000;
ok(near(row(uuid(4))[1]) && near(row(uuid(5))[1]) && near(row(uuid(6))[1]), "7日より前・未来・形の違う日時は使わず、受け付けた日時にする");

// --- 自動削除の定期実行 ---
triggers = ["runPendingJobs", "warmup"];
delete cache.purgeTriggerChecked;
load().warmup();
ok(triggers.filter(h => h === "purgeOldTranscripts").length === 1, "自動削除の定期実行が無ければ作る");
delete cache.purgeTriggerChecked;
load().warmup();
ok(triggers.filter(h => h === "purgeOldTranscripts").length === 1, "すでにあれば作らない");
