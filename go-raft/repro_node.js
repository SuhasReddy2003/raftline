const fs = require("fs");
const path = require("path");

const wasmExecPath = process.argv[2] || "wasm_exec.js";
require(path.resolve(wasmExecPath));

const go = new Go();
const wasmBuffer = fs.readFileSync(process.argv[3] || "main.wasm");

WebAssembly.instantiate(wasmBuffer, go.importObject).then(async (result) => {
  go.run(result.instance);
  global.raftline.newCluster(["n1", "n2", "n3", "n4", "n5"]);
  global.raftline.start();

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  for (let t = 1; t <= 60; t++) {
    await sleep(1000);
    const snap = global.raftline.getSnapshot();
    const states = snap.nodes.map(n => `${n.ID}:${n.State}`).join(" ");
    console.log(`t=${t}s elections=${snap.stats.ElectionsHeld} | ${states}`);
  }
  process.exit(0);
}).catch(err => { console.error("ERROR:", err); process.exit(1); });