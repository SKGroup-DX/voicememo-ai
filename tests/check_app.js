// index.html の中のすべてのスクリプトを1つずつ構文チェックする（Reactの本体も含む）
// 実行: node tests/check_app.js
const fs = require("fs"), vm = require("vm");
const h = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../index.html"), "utf8");
let ok = true;
[...h.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
  try { new vm.Script(m[1], { filename: "script_" + i }); }
  catch (e) { ok = false; const line = h.slice(0, m.index).split("\n").length; console.log("NG script", i, "(page line " + line + "+):", e.message, String(e.stack).split("\n")[1] || ""); }
});
console.log(ok ? "ALL_SCRIPTS_OK" : "SYNTAX_ERROR");
process.exitCode = ok ? 0 : 1;
