// GASの基本の動き（受け付け・要約・やり直し・ロック・合言葉など）を、モックのシート上で確かめる
// 実行: node tests/gas_core.test.js
const fs = require("fs");
const code = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../gas/Code.gs"), "utf8");
const H = ["ID","日時","名前","相手","状態","要約","文字起こし","エラー","処理開始時刻"];
let rows = [H];
const sheet = {
  getLastRow: () => rows.length, getLastColumn: () => 9, getMaxRows: () => 1000,
  getRange: (r, c, nr = 1, nc = 1) => ({
    getValues: () => rows.slice(r - 1, r - 1 + nr).map(row => { const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] ?? ""); return o; }),
    getValue: () => (rows[r - 1] || [])[c - 1] ?? "",
    setValue: v => { rows[r - 1][c - 1] = v; },
  }),
  appendRow: a => rows.push(a.slice()), deleteRow: r => rows.splice(r - 1, 1),
};
const props = { APP_PASSCODE: "k", GCP_PROJECT_ID: "p" };
const cache = {};
let lockFree = true, tokenCalls = 0, script = [], calls = 0, slept = [], onFetch = null, onSleep = null, sentPayloads = [];
const ok200 = obj => ({ code: 200, body: JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }] }) });
const sum = t => ok200({ meetingType: "1on1", sections: [{ key: "goal", label: "今日のゴール", emoji: "🎯", items: [t] }] });
const r429 = sec => ({ code: 429, body: JSON.stringify({ error: { code: 429, message: "Quota exceeded per minute", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: sec + "s" }] } }) });
// 「計測」シートなど、records 以外のシート
const extraSheets = {};
const extraSheet = () => { const data = []; return { data, getLastRow: () => data.length, setFrozenRows() {}, getRange: (r, c, nr = 1, nc = 1) => { const rg = { setValues: v => { v.forEach((row, i) => { data[r - 1 + i] = row.slice(); }); return rg; }, setFontWeight: () => rg, setBackground: () => rg }; return rg; } }; };
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => n === "records" ? sheet : (extraSheets[n] || null), insertSheet: n => (extraSheets[n] = extraSheet()), getName: () => "s" }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
  Utilities: { sleep: ms => { slept.push(ms / 1000); if (onSleep) { const f = onSleep; onSleep = null; f(); } }, getUuid: (() => { let n = 0; return () => "gen" + (++n); })(), formatDate: () => "2026-10-05 17:00:00" },
  Session: { getScriptTimeZone: () => "Asia/Tokyo" },
  LockService: { getScriptLock: () => ({ tryLock: () => lockFree, waitLock() {}, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  ScriptApp: { getOAuthToken: () => { tokenCalls++; return "t"; } },
  UrlFetchApp: { fetch: (u, o) => { calls++; sentPayloads.push(o && o.payload); if (onFetch) { const f = onFetch; onFetch = null; f(); } const r = script.shift() || sum("既定"); return { getResponseCode: () => r.code, getContentText: () => r.body }; } },
  console: { log() {}, error() {}, warn() {} },
};
// GASは実行ごとにグローバル変数がリセットされるので、毎回読み直す
const load = () => new Function(...Object.keys(ctx), code + "\nreturn { doPost, runPendingJobs, warmup };")(...Object.values(ctx));
const call = b => JSON.parse(load().doPost({ postData: { contents: JSON.stringify({ key: "k", ...b }) } }).s);
const ok = (c, m) => { console.log((c ? "OK  " : "NG  ") + m); if (!c) process.exitCode = 1; };
const st = id => rows.find(r => r[0] === id);
const reset = () => { calls = 0; slept = []; script = []; tokenCalls = 0; sentPayloads = []; };
const uuid = n => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const submit = (n, extra = {}) => call({ action: "submitTranscript", id: uuid(n), member: "m", transcript: "本文" + n, ...extra });

// --- これまでの仕様（引き継ぎ） ---
let id = submit(1).id; reset(); script = [r429(70)];
ok(call({ action: "processRecord", id }).status === "queued" && calls === 1 && slept.length === 0, "その場の要約：60秒を超える待ちならすぐ定期実行に任せる");
reset(); script = [r429(40), sum("要約1")]; load().runPendingJobs();
ok(st(id)[4] === "done" && slept[0] === 40, "定期実行：指示された40秒待って成功");
id = submit(2).id; reset(); script = [r429(30), sum("要約2")];
ok(call({ action: "processRecord", id }).status === "done" && slept[0] === 30, "その場の要約：30秒待ちならその場で待って完了");
id = submit(3).id; reset(); script = [sum("1つ目")];
onFetch = () => { st(id)[4] = "queued"; script = [r429(5), r429(5), r429(5), r429(5), r429(5), r429(5)]; load().runPendingJobs(); script = [sum("1つ目")]; };
load().runPendingJobs();
ok(st(id)[4] === "done" && JSON.parse(st(id)[5]).sections[0].items[0] === "1つ目" && st(id)[7] === "", "二重に処理されても完了を失敗で上書きしない");
id = submit(4).id; st(id)[4] = "processing"; st(id)[8] = new Date();
ok(call({ action: "retryRecord", id }).status === "processing", "処理中の記録は再試行で戻さない");
st(id)[4] = "error"; ok(call({ action: "retryRecord", id }).status === "queued" && st(id)[4] === "queued", "失敗した記録は再試行で戻る");
submit(5); const r2 = submit(5);
ok(r2.duplicate && rows.filter(r => r[0] === uuid(5)).length === 1, "同じ番号の送り直しで2件にならない");
const early = uuid(6); reset(); script = [sum("先着")];
onSleep = () => submit(6);
ok(call({ action: "processRecord", id: early }).status === "done", "要約開始が先に着いても受け付けを待って要約");

// --- 今回の修正 ---
lockFree = false; const before = rows.length;
let r = submit(10);
ok(r.success === false && r.busy === true && rows.length === before, "ロックが取れなければ書き込まずbusyを返す（アプリが送り直す）");
r = call({ action: "deleteRecord", id: uuid(1) });
ok(r.busy === true && !!st(uuid(1)), "削除もロックが取れなければ行わない");
load().warmup(); ok(true, "ロックが取れなくても止まった処理の拾い直しは安全に見送る");
lockFree = true;
rows.forEach((x, i) => { if (i > 0 && x[4] === "queued") x[4] = "done"; });
reset(); load().runPendingJobs();
ok(tokenCalls === 0 && calls === 0, "要約待ちが無ければ定期実行はすぐ終わる（認証・AI呼び出しなし）");
id = submit(11).id; reset();
script = [ok200({ meetingType: "1on1?", sections: [{ label: "今日のゴール", items: "文字列の項目" }, { label: "", items: ["ラベルなし"] }, "壊れた要素", { label: "本人の声", items: [{ a: 1 }, null, " ", "声"] }], analysis: { speakingRatio: { self: 150, other: 50 }, listeningScore: -5, openQuestionRatio: "40" } })];
r = call({ action: "processRecord", id });
const s11 = JSON.parse(st(id)[5]);
ok(r.status === "done" && s11.meetingType === "1on1" && s11.sections.length === 2 && s11.sections[0].items[0] === "文字列の項目" && s11.sections[1].items.length === 2, "崩れた要約を表示できる形に整える");
ok(s11.analysis.speakingRatio.self + s11.analysis.speakingRatio.other === 100 && s11.analysis.listeningScore === 0 && s11.analysis.openQuestionRatio === 40, "分析の数値を0〜100・合計100にそろえる");
ok(call({ action: "getHistory", member: "m", q: "声" }).success, "整えた要約はキーワード検索も壊れない");
ok(call({ action: "updateRecord", id, sections: { sections: "壊れた形" } }).success === false && JSON.parse(st(id)[5]).sections.length === 2, "編集で壊れた形を送られても保存しない");
ok(call({ action: "updateRecord", id, sections: { meetingType: "group", sections: [{ label: "x", items: Array(30).fill("い".repeat(1999)) }] } }).success === false, "大きすぎる要約は保存しない");
r = call({ action: "updateRecord", id, sections: { meetingType: "group", sections: [{ label: "主な決定事項", items: ["編集後"] }], analysis: { listeningScore: 50 } } });
ok(r.success && JSON.parse(st(id)[5]).sections[0].items[0] === "編集後" && !JSON.parse(st(id)[5]).analysis, "正しい編集は保存（会議では分析を外す）");
props.GEMINI_MODEL = "lite-x"; delete props["NO_FAST_CONFIG_lite-x"];
const e400 = msg => ({ code: 400, body: JSON.stringify({ error: { code: 400, message: msg } }) });
id = submit(12).id; reset(); script = [e400("Request contains an invalid argument."), sum("A")];
call({ action: "processRecord", id });
ok(!props["NO_FAST_CONFIG_lite-x"] && st(id)[4] === "done", "原因が分からない400では高速化の設定を止めない（要約は従来設定で完了）");
id = submit(13).id; reset(); script = [e400("thinking_level is not supported by this model"), sum("B")];
call({ action: "processRecord", id });
ok(props["NO_THINKING_lite-x"] === "1" && !props["NO_FAST_CONFIG_lite-x"], "考える量の指定が原因の400は覚える（JSONの指定は続けて使う）");
id = submit(14).id; reset(); script = [sum("C")];
call({ action: "processRecord", id });
ok(calls === 1 && !String(sentPayloads[0]).includes("thinkingConfig") && String(sentPayloads[0]).includes("responseMimeType"), "覚えた後は最初から考える量の指定なしで1回だけ呼ぶ");
call({ action: "submitTranscript", id: uuid(15), member: "m", interviewee: "=IMPORTDATA(\"x\")", transcript: "- 議題1について" });
ok(st(uuid(15))[3].startsWith("'=") && st(uuid(15))[6].startsWith("'-"), "先頭が = や - の文字は ' を付けて保存");
const h15 = call({ action: "getHistory", member: "m", q: "議題1" });
ok(h15.total === 1 && h15.records[0].interviewee === "=IMPORTDATA(\"x\")" && call({ action: "getTranscript", id: uuid(15) }).transcript === "- 議題1について", "読むときは元の文字に戻る（検索・表示とも）");
ok(submit(16, { member: "長".repeat(51) }).success === false, "名前が長すぎると受け付けない");
id = submit(17).id; reset(); script = [{ code: 200, body: JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] }) }];
r = call({ action: "processRecord", id });
ok(r.status === "error" && st(id)[4] === "error" && /安全確認/.test(st(id)[7]) && calls === 1, "安全確認で止められたら、その場で失敗にする（無料枠を無駄にしない）");
id = submit(18).id; reset(); script = [{ code: 200, body: JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "{\"sec" }] } }] }) }];
ok(call({ action: "processRecord", id }).status === "error" && /長くなりすぎ/.test(st(id)[7]), "途中で止まった要約は分かりやすい文言で失敗にする");
const e403 = { code: 403, body: JSON.stringify({ error: { code: 403, message: "Permission denied on project 123456789" } }) };
rows.forEach((x, i) => { if (i > 0 && x[4] === "queued") x[4] = "done"; });
id = submit(19).id; reset(); script = [e403]; call({ action: "processRecord", id });
reset(); script = [e403]; load().runPendingJobs();
ok(st(id)[4] === "error" && !st(id)[7].includes("123456789"), "内部の情報（プロジェクト番号など）をエラー欄に出さない");
const multi = call({ action: "getRecordStatuses", ids: [uuid(15), uuid(17), uuid(999)] });
ok(multi.success && multi.results[uuid(15)].status === "done" && multi.results[uuid(17)].status === "error" && multi.results[uuid(999)].found === false, "複数の記録の状況を1回で返す");
ok(call({ action: "deleteRecord", id: uuid(17) }).success && call({ action: "deleteRecord", id: uuid(17) }).alreadyDeleted, "削除の送り直しは成功扱い");
reset(); for (let i = 0; i < 25; i++) load().doPost({ postData: { contents: JSON.stringify({ key: "x", action: "checkPasscode" }) } });
ok(slept.length === 20, "失敗が20回を超えたら待たずに断る（それまでは2秒待たせる）");
ok(call({ action: "checkPasscode" }).success === true, "正しい合言葉はその間も使える");
id = submit(20).id; st(id)[4] = "processing"; st(id)[8] = new Date(Date.now() - 11 * 60 * 1000);
load().warmup(); ok(st(id)[4] === "queued", "10分以上止まった処理は要約待ちに戻す");
