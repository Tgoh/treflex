import type { IActionGenerator, IOpenGenerator } from "../../src/index";
import type { IOrder } from "./resumeHarness";
import { describe, expect, it } from "vitest";
import { start } from "../../src/Effects/start";
import { resumable } from "../../src/Resume/resumable";
import { named } from "../../src/Runtime/named";
import { open } from "../../src/Runtime/open";
import { redactArgs } from "../../src/Runtime/redactArgs";
import { harness, shop, until, wait } from "./resumeHarness";

const received: string[] = [];

function* login(_draft: IOrder, password: string): IActionGenerator {
	received.push(password);
	yield* wait("login");
}
named(login, "RedactArgs/Login");
redactArgs(login);

function* signIn(_draft: IOrder): IOpenGenerator {
	yield* start(login, "o2", "hunter2");
	yield* open(wait("signed-in"));
}
named(signIn, "RedactArgs/SignIn");
resumable(signIn);

describe("a redacted action under resume", () => {
	it("leaves none of its arguments in a resumable parent's kept start, or anywhere in the save", async () => {
		const h = harness(shop());
		const running = h.runtime.dispatch(signIn, "o1");
		await until(() => h.waiting.some((w) => w.name === "signed-in") && h.waiting.some((w) => w.name === "login"));
		expect(received).toEqual([
			"hunter2"
		]);

		const history = h.historyOf("RedactArgs/SignIn");
		expect(JSON.stringify(history)).toContain('"ArgsRedacted":true');
		const saved = JSON.stringify(h.envelope());
		expect(saved).not.toContain("hunter2");
		expect(h.envelope().InFlight.map((row) => row.Name)).toContain("RedactArgs/Login");

		h.release("login");
		h.release("signed-in");
		await running;
		expect(h.diags).toEqual([]);
	});
});
