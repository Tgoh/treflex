// node run-built.mjs <app>: loads <app>/dist/index.html into jsdom, runs its
// built module scripts, and prints the result shared/report.ts leaves on the body.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const dist = resolve(process.argv[2], "dist");
const html = readFileSync(join(dist, "index.html"), "utf8");
const { window } = new JSDOM(html, {
	url: "http://localhost/",
	pretendToBeVisual: true
});

for (const key of Object.getOwnPropertyNames(window)) {
	if (!(key in globalThis)) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			get: () => window[key]
		});
	}
}

for (const script of window.document.querySelectorAll("script[type=module][src]")) {
	await import(pathToFileURL(join(dist, script.getAttribute("src"))).href);
}

const deadline = Date.now() + 15000;
while (window.document.body.dataset.result === undefined) {
	if (Date.now() > deadline) {
		console.error("the app never reported a result");
		process.exit(1);
	}
	await new Promise((r) => setTimeout(r, 20));
}
console.log(window.document.body.dataset.result);
process.exit(0);
