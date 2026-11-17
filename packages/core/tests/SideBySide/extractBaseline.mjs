import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REF = "e8cb54896ff8f693c4188fc976090c59f5169a38";
const SOURCE = "packages/core/src";

const ref = process.argv[2] ?? process.env.SIDE_BY_SIDE_REF ?? DEFAULT_REF;
const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "baseline");

const resolved = spawnSync(
	"git",
	[
		"rev-parse",
		"--verify",
		"--quiet",
		`${ref}^{commit}`
	],
	{
		cwd: here,
		encoding: "utf8"
	}
);
if (resolved.status !== 0) {
	console.error(
		`${ref} is not a commit in this clone: pass a ref that predates the wake queue, as the first argument or SIDE_BY_SIDE_REF.`
	);
	process.exit(1);
}
const sha = resolved.stdout.trim();
const paths = execFileSync(
	"git",
	[
		"ls-tree",
		"-r",
		"--full-tree",
		"--name-only",
		sha,
		"--",
		SOURCE
	],
	{
		cwd: here,
		encoding: "utf8",
		maxBuffer: 1 << 26
	}
)
	.split("\n")
	.filter((path) => path !== "");
if (paths.length === 0) {
	throw new Error(`${sha} has no ${SOURCE}`);
}

const batch = spawnSync(
	"git",
	[
		"cat-file",
		"--batch"
	],
	{
		cwd: here,
		input: `${paths.map((path) => `${sha}:${path}`).join("\n")}\n`,
		maxBuffer: 1 << 28
	}
);
if (batch.status !== 0) {
	throw new Error(`git cat-file failed: ${batch.stderr.toString()}`);
}

rmSync(target, {
	recursive: true,
	force: true
});
const out = batch.stdout;
let at = 0;
for (const path of paths) {
	const headerEnd = out.indexOf(0x0a, at);
	const [, kind, size] = out.subarray(at, headerEnd).toString("utf8").split(" ");
	if (kind !== "blob") {
		throw new Error(`${path} at ${sha} is a ${kind}`);
	}
	const start = headerEnd + 1;
	const end = start + Number(size);
	const file = join(target, path);
	mkdirSync(dirname(file), {
		recursive: true
	});
	writeFileSync(file, out.subarray(start, end));
	at = end + 1;
}
writeFileSync(join(target, "REF"), `${sha}\n`);
console.log(`Extracted ${paths.length} files of ${SOURCE} at ${sha} into ${target}`);
