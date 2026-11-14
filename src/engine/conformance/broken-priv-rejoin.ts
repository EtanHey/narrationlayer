import engine from "./engine-binding";
import { privacyText } from "./privacy-cases";
const out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr);
const reverse = process.argv.includes("--reverse"), text = privacyText.slice(0, 8);
process.on("exit", () => { if (reverse) out(text.slice(4)); else { out(text.slice(0, 4)); err(privacyText.slice(8, 16)); } });
export default engine;
