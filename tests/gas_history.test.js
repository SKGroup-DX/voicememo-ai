// 履歴・状況確認の読み込み（必要な行だけ読む）と、相手での絞り込みの確認
// 実行: node tests/gas_history.test.js
const fs = require("fs");
const code = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../gas/Code.gs"), "utf8");
let rows = [["ID", "日時", "名前", "相手", "状態", "要約", "文字起こし", "エラー", "処理開始時刻"]];
let readCells = 0; // 読んだセルの数（全員分を読んでいないかを確かめる）
let finderOn = true;
const sheet = {
  getLastRow: () => rows.length, getLastColumn: () => 9, getMaxRows: () => 100000,
  getRange: (r, c, nr = 1, nc = 1) => ({
    getValues: () => { readCells += nr * nc; return rows.slice(r - 1, r - 1 + nr).map(row => { const o = []; for (let j = 0; j < nc; j++) o.push(row[c - 1 + j] ?? ""); return o; }); },
    getValue: () => (rows[r - 1] || [])[c - 1] ?? "",
    setValue: v => { rows[r - 1][c - 1] = v; },
    createTextFinder: term => {
      if (!finderOn) throw new Error("TextFinder unavailable");
      return {
        matchCase() { return this; },
        findAll: () => {
          const out = [];
          for (let i = r; i < r + nr; i++) for (let j = c; j < c + nc; j++) {
            if (String(rows[i - 1][j - 1] ?? "").toLowerCase().includes(term.toLowerCase())) out.push({ getRow: () => i });
          }
          return out;
        }
      };
    },
  }),
  appendRow: a => rows.push(a.slice()),
};
const props = { APP_PASSCODE: "k", GCP_PROJECT_ID: "p" };
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: n => n === "records" ? sheet : null, getName: () => "s" }), flush() {} },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => Object.assign({}, props), getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
  Utilities: { sleep() {}, getUuid: () => "x", formatDate: () => "2026-10-10 10:00:00" },
  Session: { getScriptTimeZone: () => "Asia/Tokyo" },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 1 } },
  ScriptApp: { getOAuthToken: () => "t" },
  UrlFetchApp: { fetch: () => { throw new Error("AIは呼ばない"); } },
  console: { log() {}, warn() {}, error() {} },
};
const call = b => JSON.parse(new Function(...Object.keys(ctx), code + "\nreturn { doPost };")(...Object.values(ctx)).doPost({ postData: { contents: JSON.stringify({ key: "k", ...b }) } }).s);
const ok = (c, m) => { console.log((c ? "OK  " : "NG  ") + m); if (!c) process.exitCode = 1; };
const summary = (type, text) => JSON.stringify({ meetingType: type, sections: [{ label: type === "group" ? "主な決定事項" : "今日のゴール", items: [text] }] });

// 他の人の記録を大量に、自分の記録を少しだけ置く
for (let i = 0; i < 1500; i++) rows.push(["o" + i, "2026-09-01 10:00:00", "他人", "誰か", "done", summary("1on1", "他人の要約" + i), "他人の文字起こし" + i, "", ""]);
const mine = (id, person, type, text, transcript) => rows.push([id, "2026-10-01 10:00:00", "自分", person, "done", summary(type, text), transcript, "", ""]);
mine("m1", "山田", "1on1", "役割を決める", "山田さんと来期の役割について話した");
for (let i = 0; i < 30; i++) rows.push(["o2-" + i, "2026-09-02 10:00:00", "他人", "誰か", "done", summary("group", "会議" + i), "本文", "", ""]);
mine("m2", "営業会議", "group", "新規開拓を増やす", "営業会議で予算の話をした");
mine("m3", "山田", "1on1", "テンプレートを作る", "資料作りの負担について");

readCells = 0;
let h = call({ action: "getHistory", member: "自分", limit: 20 });
ok(h.success && h.total === 3 && h.records.map(r => r.id).join() === "m3,m2,m1", "自分の記録だけを新しい順に返す");
ok(readCells < 1600 * 9, "他の人の要約や文字起こしまでは読まない（読んだセル " + readCells + "）");
ok(h.records[0].sections.sections[0].items[0] === "テンプレートを作る" && h.records[0].hasTranscript === true, "要約と文字起こしの有無は今までどおり返す");

h = call({ action: "getHistory", member: "自分", limit: 2, offset: 0 });
const h2 = call({ action: "getHistory", member: "自分", limit: 2, offset: 2 });
ok(h.records.length === 2 && h.hasMore && h2.records.map(r => r.id).join() === "m1" && !h2.hasMore, "続きの読み込み（ページ分け）も今までどおり");

h = call({ action: "getHistory", member: "自分", person: "山田" });
ok(h.total === 2 && h.records.every(r => r.interviewee === "山田"), "相手で絞り込める（完全一致）");
h = call({ action: "getHistory", member: "自分", type: "group" });
ok(h.total === 1 && h.records[0].id === "m2", "種類の絞り込みも今までどおり");

readCells = 0;
h = call({ action: "getHistory", member: "自分", q: "予算" });
ok(h.total === 1 && h.records[0].id === "m2", "文字起こしの中の言葉で探せる");
ok(readCells < 1600 * 9, "検索でも全員分の文字起こしは読まない（読んだセル " + readCells + "）");
h = call({ action: "getHistory", member: "自分", q: "山田 負担" });
ok(h.total === 1 && h.records[0].id === "m3", "複数の言葉はすべてを含む記録だけ");
h = call({ action: "getHistory", member: "自分", q: "label" });
ok(h.total === 0, "要約の内部の書き方（label など）には当たらない");
finderOn = false;
h = call({ action: "getHistory", member: "自分", q: "予算" });
ok(h.total === 1 && h.records[0].id === "m2", "検索機能が使えないときも、同じ結果になる");
finderOn = true;

readCells = 0;
const st = call({ action: "getRecordStatuses", ids: ["m1", "m3", "none"] });
ok(st.success && st.results.m1.status === "done" && st.results.m3.sections.sections[0].items[0] === "テンプレートを作る" && st.results.none.found === false, "複数の記録の状況をまとめて返す");
ok(readCells < 3000, "状況確認は ID の列と該当の行だけを読む（読んだセル " + readCells + "）");
