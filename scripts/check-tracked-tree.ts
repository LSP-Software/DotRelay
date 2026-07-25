export {};

const status = await Bun.$`git status --porcelain`.text();
if (status.trim()) {
  console.error(
    "tracked-tree-clean failed: repository changed during the gate",
  );
  console.error(status);
  process.exit(1);
}
console.log("✓ tracked tree is clean");
