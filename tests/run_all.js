// すべてのテストを順に実行する（1つでも失敗したら終了コード1）
// 実行: node tests/run_all.js
const { spawnSync } = require("child_process");
const path = require("path");
const files = ["check_app.js", "gas_core.test.js", "gas_retention.test.js", "gas_features.test.js", "gas_speed.test.js", "gas_history.test.js"];
let failed = 0;
files.forEach(f => {
  console.log("\n=== " + f + " ===");
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
});
console.log(failed ? "\n" + failed + "件のテストファイルで失敗がありました" : "\nすべて合格");
process.exitCode = failed ? 1 : 0;
