import { fileURLToPath } from "node:url";
import { lintRepo } from "./lint";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { files, findings } = await lintRepo(root);

for (const f of findings) console.error(`${f.file}:${f.line}  [${f.rule}]  ${f.text}`);
if (findings.length > 0) {
  console.error(`\ncopy lint: ${findings.length} problem(s) in ${files.length} copy file(s)`);
  process.exit(1);
}
console.log(`copy lint: ${files.length} copy file(s) clean`);
