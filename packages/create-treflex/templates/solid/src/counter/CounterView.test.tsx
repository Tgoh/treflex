// @vitest-environment jsdom
import { render } from "solid-js/web";
import { createTestRuntime, guids, settled } from "treflex";
import { TreflexProvider } from "treflex-solid";
import { expect, it } from "vitest";
import { CounterView } from "./CounterView";
import type { ICounter } from "./counter";

it("shows the count once the delay ends, busy until then", async () => {
	let endDelay = () => {};
	const runtime = createTestRuntime<ICounter>(
		{ $Id: "Counter", Count: 0, Notice: "" },
		{
			generateGuid: guids("counter"),
			"Counter/Delay": () =>
				new Promise<void>((resolve) => {
					endDelay = resolve;
				}),
		},
	);
	const host = document.body.appendChild(document.createElement("div"));
	const dispose = render(
		() => (
			<TreflexProvider value={runtime}>
				<CounterView state={runtime.state} />
			</TreflexProvider>
		),
		host,
	);
	const button = host.querySelector("button") as HTMLButtonElement;
	button.click();
	await settled();
	expect(button.textContent).toBe("Counting...");
	expect(button.disabled).toBe(true);
	endDelay();
	await settled();
	expect(host.textContent).toContain("1 click");
	dispose();
	host.remove();
});
