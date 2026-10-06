// 速さのための仕組みの確認：本文付きの要約開始・受け付け直後の待ち・AIの短い返答・考える量・計測
// 実行: node tests/gas_speed.test.js
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
const extraSheets = {};
const extraSheet = () => { const data = []; return { data, getLastRow: () => data.length, setFrozenRows() {}, getRange: (r, c, nr = 1, nc = 1) => { const rg = { setValues: v => { v.forEach((row, i) => { data[r - 1 + i] = row.slice(); }); return rg; }, setFontWeight: () => rg, setBackground: () => rg }; return rg; } }; };
const props = { APP_PASSCODE: "k", GCP_PROJECT_ID: "p" };
const cache = {};
let script = [];
let payloads = [];
let onSleep = null;
const p2 = n => String(n).padStart(2, "0");
const local = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const reply = obj => ({ code: 200, body: JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
const compact1on1 = { meetingType: "1on1", goal: ["役割を決める"], voice: ["説明役をやりたい"], action: ["テンプレートを作る"], follow: [], analysis: { self: 30, other: 70, listening: 80, comment: "よく聴けています", open: 60 } };
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => n === "records" ? sheet : (extraSheets[n] || null), insertSheet: n => (extraSheets[n] = extraSheet()), getName: () => "s" }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } }) },
  Utilities: { sleep() { if (onSleep) { const f = onSleep; onSleep = null; f(); } }, getUuid: () => "x", formatDate: d => local(d) },
  Session: { getScriptTimeZone: () => "Asia/Tokyo" },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  ScriptApp: { getOAuthToken: () => "t" },
  UrlFetchApp: {
    fetch: (u, o) => {
      payloads.push(JSON.parse(o.payload));
      const r = script.shift() || reply(compact1on1);
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    }
  },
  console: { log() {}, warn() {}, error() {} },
};
const load = () => new Function(...Object.keys(ctx), code + "\nreturn { doPost, runPendingJobs };")(...Object.values(ctx));
const call = b => JSON.parse(load().doPost({ postData: { contents: JSON.stringify({ key: "k", ...b }) } }).s);
const ok = (c, m) => { console.log((c ? "OK  " : "NG  ") + m); if (!c) process.exitCode = 1; };
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const row = id => rows.find(r => r[0] === id);
const reset = () => { script = []; payloads = []; };
const submit = (n, text, extra = {}) => call({ action: "submitTranscript", id: uuid(n), member: "m", transcript: text, recordedAt: local(new Date()), ...extra });

// --- AIの短い返答 ---
let id = uuid(1);
submit(1, "本文1");
reset();
let r = call({ action: "processRecord", id });
let s = JSON.parse(row(id)[5]);
ok(r.status === "done" && s.sections.map(x => x.label).join() === "今日のゴール,本人の声,アクション,フォロー事項" && s.sections[0].emoji === "🎯", "短い返答（goal など）を、見出しの名前・絵文字付きの形に直して保存する");
ok(s.sections[3].items[0] === "特になし", "空の項目は「特になし」にする");
ok(s.analysis.speakingRatio.self === 30 && s.analysis.listeningScore === 80 && s.analysis.listeningComment === "よく聴けています" && s.analysis.openQuestionRatio === 60, "面談分析も保存する形に直す");
const prompt = payloads[0].contents[0].parts[0].text;
ok(!prompt.includes("emoji") && prompt.includes("goal：今日のゴール"), "AIには絵文字や見出しの名前を書かせない");
ok(payloads[0].generationConfig.thinkingConfig.thinkingLevel === "low" && payloads[0].generationConfig.responseMimeType === "application/json", "考える量は既定で low、返答はJSON");

// --- 本文付きの要約開始 ---
id = uuid(2);
reset();
onSleep = () => submit(2, "本文2");
r = call({ action: "processRecord", id, transcript: "本文2" });
ok(r.status === "done" && row(id)[4] === "done" && payloads.length === 1, "受け付けの保存より先に届いても、先にAIを呼び、保存を待って書き込む");

id = uuid(3);
submit(3, "本文3");
row(id)[4] = "done";
row(id)[5] = JSON.stringify({ meetingType: "group", sections: [{ label: "x", items: ["先にできた要約"] }] });
r = call({ action: "processRecord", id, transcript: "本文3" });
ok(r.status === "done" && JSON.parse(row(id)[5]).sections[0].items[0] === "先にできた要約", "すでに完了していれば書き込まない");

id = uuid(4);
submit(4, "本文4");
r = call({ action: "processRecord", id, transcript: "違う本文" });
ok(r.status === "queued" && row(id)[4] === "queued" && row(id)[5] === "", "本文が違えば書き込まない（通常の流れに任せる）");

id = uuid(5);
submit(5, "本文5");
reset();
script = [{ code: 200, body: JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }) }];
r = call({ action: "processRecord", id, transcript: "本文5" });
ok(r.status === "error" && row(id)[4] === "error", "やり直しても同じ結果になる失敗は、その場で失敗にする");

// --- 受け付け直後の待ち ---
rows = [rows[0]];
submit(6, "本文6");
reset();
load().runPendingJobs();
ok(payloads.length === 0 && row(uuid(6))[4] === "queued", "受け付けたばかりの記録は、定期実行が拾わない（本文付きの要約と二重にしない）");
reset();
script = [{ code: 429, body: JSON.stringify({ error: { code: 429, message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "70s" }] } }) }];
r = call({ action: "processRecord", id: uuid(6), transcript: "本文6" });
ok(r.status === "queued" && !!row(uuid(6))[8], "本文付きの要約が一時的に失敗したら、処理開始時刻を入れる");
reset();
load().runPendingJobs();
ok(row(uuid(6))[4] === "done" && payloads.length === 1, "その記録は、待たずに定期実行が拾う");
submit(7, "本文7", { recordedAt: local(new Date(Date.now() - 5 * 60 * 1000)) });
reset();
load().runPendingJobs();
ok(row(uuid(7))[4] === "done", "要約開始が届かないまま3分たった記録は、定期実行が拾う");

// --- 考える量 ---
props.GEMINI_THINKING_LEVEL = "minimal";
submit(8, "本文8");
reset();
script = [{ code: 400, body: JSON.stringify({ error: { code: 400, message: "thinking level MINIMAL is not supported" } }) }, reply(compact1on1)];
call({ action: "processRecord", id: uuid(8) });
ok(payloads[0].generationConfig.thinkingConfig.thinkingLevel === "minimal" && payloads[1].generationConfig.thinkingConfig.thinkingLevel === "low" && row(uuid(8))[4] === "done", "minimal を断られたら low でやり直す");
ok(!props["NO_THINKING_gemini-3.5-flash-lite"], "low は使えるので、考える量の指定そのものはやめない");
delete props.GEMINI_THINKING_LEVEL;

// --- 計測 ---
ok(JSON.parse(cache.timings || "[]").some(t => t[2] === "その場" && t[12] === "完了"), "要約ごとの所要時間は、まずキャッシュにためる（結果を返すのを遅らせない）");
load().runPendingJobs();
const tsheet = extraSheets["計測"];
ok(!!tsheet && tsheet.data[0][0] === "日時" && tsheet.data.length === 8 && tsheet.data[1].length === 13 && !cache.timings, "定期実行が「計測」シートにまとめて書く");
ok(tsheet.data.some(t => t[2] === "その場（本文付き）" && t[12] === "後回し") && tsheet.data.some(t => t[2] === "定期実行" && t[12] === "完了"), "経路と結果（完了・後回し・失敗）を記録する");
ok(tsheet.data.slice(1).some(t => t[2] === "その場（本文付き）" && typeof t[7] === "number" && t[11] !== ""), "AIの秒数・押してから完了までの秒数が入る");
