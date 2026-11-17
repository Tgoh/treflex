// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
} from "@testing-library/react";
import { createTestRuntime, guids, settled } from "treflex";
import { TreflexProvider, useRoot } from "treflex-react";
import { afterEach, expect, it } from "vitest";
import { CounterView } from "./CounterView";
import type { ICounter } from "./counter";

afterEach(cleanup);

function Root() {
	return <CounterView state={useRoot<ICounter>()} />;
}

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
	render(
		<TreflexProvider value={runtime}>
			<Root />
		</TreflexProvider>,
	);
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Count" }));
		await settled();
	});
	const button = screen.getByRole("button") as HTMLButtonElement;
	expect(button.textContent).toBe("Counting...");
	expect(button.disabled).toBe(true);
	await act(async () => {
		endDelay();
		await settled();
	});
	expect(screen.getByText("1 click")).toBeTruthy();
});
