import type { IBuild } from "../../portal/src/shell/builds";
import type { IRendererModule, ISwappedPortal } from "./swap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSwap } from "./swap";

interface IFaults {
	failLoads?: Partial<Record<IBuild, number>>;
	mountThrows?: Partial<Record<IBuild, number>>;
	unmountThrows?: Partial<Record<IBuild, number>>;
	failStopThrows?: number;
	failThrows?: number;
	/** Holds React's load until it settles. */
	reactGate?: Promise<void>;
}

/** Renderers whose views are a plain element, and whose loads, mounts and unmounts throw as many times as `faults` says. */
function fakeRenderers(faults: IFaults = {}) {
	const log: string[] = [];
	const count = (key: "failLoads" | "mountThrows" | "unmountThrows", renderer: IBuild): boolean => {
		const left = faults[key]?.[renderer] ?? 0;
		if (left === 0) return false;
		faults[key] = {
			...faults[key],
			[renderer]: left - 1
		};
		return true;
	};
	const module = (renderer: IBuild): IRendererModule => ({
		mount: (element) => {
			if (count("mountThrows", renderer)) {
				log.push(`mount throws ${renderer}`);
				throw new Error(`mount ${renderer}`);
			}
			const view = element.ownerDocument.createElement("section");
			view.className = `view ${renderer}`;
			const segment = element.ownerDocument.createElement("fieldset");
			segment.className = "seg";
			const pressed = element.ownerDocument.createElement("button");
			pressed.setAttribute("aria-pressed", "true");
			pressed.textContent = renderer;
			segment.append(pressed);
			view.append(segment);
			element.append(view);
			log.push(`mount ${renderer}`);
			return () => {
				log.push(`unmount ${renderer}`);
				if (count("unmountThrows", renderer)) throw new Error(`unmount ${renderer}`);
				view.remove();
			};
		},
		fail: (element) => {
			if ((faults.failThrows ?? 0) > 0) {
				faults.failThrows!--;
				throw new Error("fail card");
			}
			const card = element.ownerDocument.createElement("section");
			card.className = `boot-failed ${renderer}`;
			element.append(card);
			log.push(`fail ${renderer}`);
			return () => {
				card.remove();
				if ((faults.failStopThrows ?? 0) > 0) {
					faults.failStopThrows!--;
					throw new Error("fail card stop");
				}
			};
		}
	});
	const loader = (renderer: IBuild) => async (): Promise<IRendererModule> => {
		if (renderer === "react") await faults.reactGate;
		if (count("failLoads", renderer)) throw new Error(`load ${renderer}`);
		return module(renderer);
	};
	return {
		log,
		faults,
		renderers: {
			solid: loader("solid"),
			react: loader("react")
		}
	};
}

let element: HTMLElement;
const started: ISwappedPortal[] = [];
let errors: unknown[][];
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
	element = document.createElement("div");
	document.body.append(element);
	errors = [];
	unhandled = [];
	vi.spyOn(console, "error").mockImplementation((...args) => {
		errors.push(args);
	});
	process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
	for (const each of started.splice(0)) {
		each.unmount();
		each.host.autosave.disable();
		each.runtime.dispose();
	}
	process.off("unhandledRejection", onUnhandled);
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

async function start(faults: IFaults = {}, onSwitch?: (renderer: IBuild) => void) {
	const fake = fakeRenderers(faults);
	let value: string | null = null;
	const swapped = await startSwap({
		element,
		renderers: fake.renderers,
		initial: "solid",
		store: {
			read: () => value,
			write: (next) => {
				value = next;
			},
			clear: () => {
				value = null;
			}
		},
		document: {
			visibilityState: "visible",
			addEventListener: () => {}
		},
		window: {
			addEventListener: () => {}
		},
		reload: () => {},
		onSwitch
	});
	if (!swapped) throw new Error("the portal didn't boot");
	started.push(swapped);
	return {
		swapped,
		log: fake.log,
		faults: fake.faults
	};
}

const shown = () =>
	[
		...element.querySelectorAll("section")
	].map((section) => section.className);

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a swap whose mount or unmount throws", () => {
	it("puts the old view back when the new one's mount throws, says so, and swaps on the next ask", async () => {
		const { swapped, log } = await start({
			mountThrows: {
				react: 1
			}
		});
		await swapped.switchTo("react");
		expect(swapped.current()).toBe("solid");
		expect(shown()).toEqual([
			"view solid"
		]);
		expect(element.childElementCount).toBe(1);
		expect(swapped.swap.pending()).toBeNull();
		expect(swapped.note.textContent).toBe("Couldn't switch to React. Try again.");

		await swapped.switchTo("react");
		expect(swapped.current()).toBe("react");
		expect(shown()).toEqual([
			"view react"
		]);
		expect(swapped.note.textContent).toBe("");
		expect(log).toEqual([
			"mount solid",
			"unmount solid",
			"mount throws react",
			"mount solid",
			"unmount solid",
			"mount react"
		]);
	});

	it("shows the failed card when the first mount throws, and clears it once a view mounts", async () => {
		const { swapped } = await start({
			mountThrows: {
				solid: 1
			}
		});
		expect(swapped.current()).toBeUndefined();
		expect(shown()).toEqual([
			"boot-failed solid"
		]);

		await swapped.switchTo("solid");
		expect(shown()).toEqual([
			"view solid"
		]);
		expect(element.childElementCount).toBe(1);
	});

	it("shows the failed card when the new view's mount throws and putting the old one back throws too", async () => {
		const { swapped, faults } = await start();
		faults.mountThrows = {
			react: 1,
			solid: 1
		};
		await swapped.switchTo("react");
		expect(swapped.current()).toBeUndefined();
		expect(shown()).toEqual([
			"boot-failed solid"
		]);
		expect(swapped.note.textContent).toBe("");

		await swapped.switchTo("react");
		expect(shown()).toEqual([
			"view react"
		]);
		expect(element.childElementCount).toBe(1);
	});

	it("goes on to mount the new view when the old one's unmount throws, with nothing unhandled", async () => {
		const { swapped } = await start({
			unmountThrows: {
				solid: 1
			}
		});
		swapped.swap.switchTo("react");
		await swapped.switchTo("react");
		await flush();
		expect(swapped.current()).toBe("react");
		expect(element.querySelectorAll(".view.react")).toHaveLength(1);
		expect(element.childElementCount).toBe(1);
		expect(unhandled).toEqual([]);
		expect(errors.length).toBeGreaterThan(0);
	});

	it("shows the failed-load message when the first load fails, and clears it once a view mounts", async () => {
		const { swapped } = await start({
			failLoads: {
				solid: 2
			}
		});
		expect(swapped.current()).toBeUndefined();
		expect(element.textContent).toBe("The portal's view didn't load. Reload the page to try again.");

		await swapped.switchTo("solid");
		expect(swapped.current()).toBe("solid");
		expect(element.textContent).toBe("solid");
		expect(shown()).toEqual([
			"view solid"
		]);
	});

	it("keeps the old view when a load fails, and retries it on the next ask", async () => {
		const { swapped } = await start({
			failLoads: {
				react: 1
			}
		});
		await swapped.switchTo("react");
		expect(swapped.current()).toBe("solid");
		expect(swapped.note.textContent).toBe("Couldn't switch to React. Try again.");
		await swapped.switchTo("react");
		expect(swapped.current()).toBe("react");
		expect(element.childElementCount).toBe(1);
	});

	it("keeps a keyboard user's focus on the toggle when the new view's mount throws and the old one comes back", async () => {
		const { swapped } = await start({
			mountThrows: {
				react: 1
			}
		});
		element.querySelector<HTMLButtonElement>(".view.solid .seg button")!.focus();
		await swapped.switchTo("react");
		expect(swapped.current()).toBe("solid");
		expect(document.activeElement).toBe(element.querySelector(".view.solid .seg [aria-pressed='true']"));
	});
});

describe("a swap whose bookkeeping throws", () => {
	it("leaves nothing unhandled when onSwitch throws, and swaps again on the next ask", async () => {
		let throws = 0;
		const { swapped } = await start({}, () => {
			if (throws > 0) {
				throws--;
				throw new Error("replaceState refused");
			}
		});
		throws = 1;
		swapped.swap.switchTo("react");
		await flush();
		await flush();
		expect(swapped.current()).toBe("react");
		expect(unhandled).toEqual([]);
		expect(errors.some((args) => String(args[1]).includes("replaceState refused"))).toBe(true);

		swapped.swap.switchTo("solid");
		await flush();
		await flush();
		expect(swapped.current()).toBe("solid");
		expect(swapped.swap.pending()).toBeNull();
	});

	it("calls onSwitch once per swap, with the renderer it settled on", async () => {
		const switched: IBuild[] = [];
		const { swapped } = await start({}, (renderer) => switched.push(renderer));
		expect(switched).toEqual([
			"solid"
		]);
		await Promise.all([
			swapped.switchTo("react"),
			swapped.switchTo("solid"),
			swapped.switchTo("react")
		]);
		await swapped.switchTo("solid");
		await swapped.switchTo("solid");
		expect(switched).toEqual([
			"solid",
			"react",
			"solid"
		]);
	});

	it("carries out an ask made from onSwitch", async () => {
		let late: Promise<void> | undefined;
		const holder: {
			swapped?: ISwappedPortal;
		} = {};
		const { swapped } = await start({}, (renderer) => {
			if (renderer === "react" && !late) late = holder.swapped!.switchTo("solid");
		});
		holder.swapped = swapped;
		await swapped.switchTo("react");
		expect(late).toBeDefined();
		await late;
		expect(swapped.current()).toBe("solid");
		expect(swapped.swap.pending()).toBeNull();
	});

	it("settles the status when a status listener throws", async () => {
		const { swapped } = await start();
		let throws = 1;
		swapped.swap.onPendingChange(() => {
			if (throws-- > 0) throw new Error("listener");
		});
		await swapped.switchTo("react");
		expect(swapped.swap.pending()).toBeNull();
		expect(unhandled).toEqual([]);
	});

	it("settles the status when the failed card's unmount throws", async () => {
		const { swapped, faults } = await start({
			mountThrows: {
				solid: 1
			}
		});
		expect(shown()).toEqual([
			"boot-failed solid"
		]);
		faults.failStopThrows = 2;
		await swapped.switchTo("solid");
		expect(swapped.swap.pending()).toBeNull();
		expect(shown()).toEqual([
			"view solid"
		]);

		faults.mountThrows = {
			react: 1,
			solid: 1
		};
		await swapped.switchTo("react");
		expect(swapped.current()).toBeUndefined();
		expect(shown()).toEqual([
			"boot-failed solid"
		]);
		expect(swapped.swap.pending()).toBeNull();
		faults.failStopThrows = 0;
	});
});

describe("an ask made from a status listener during a swap", () => {
	it("does not start a second swap beside the running one", async () => {
		const { swapped, log } = await start();
		log.length = 0;
		let asked = false;
		swapped.swap.onPendingChange((pending) => {
			if (!asked && pending === "react") {
				asked = true;
				swapped.swap.switchTo("react");
			}
		});
		await swapped.switchTo("react");
		for (let i = 0; i < 5; i++) await flush();
		expect(asked).toBe(true);
		expect(log).toEqual([
			"unmount solid",
			"mount react"
		]);
		expect(element.childElementCount).toBe(1);
	});

	it("resolves only once its renderer is mounted, when made as the swap settles", async () => {
		const { swapped } = await start();
		let late: Promise<void> | undefined;
		swapped.swap.onPendingChange((pending) => {
			if (!late && pending === null && swapped.current() === "react") late = swapped.switchTo("solid");
		});
		await swapped.switchTo("react");
		expect(late).toBeDefined();
		await late;
		expect(swapped.current()).toBe("solid");
		expect(swapped.swap.pending()).toBeNull();
	});

	it("puts the last view that mounted back, when made while that view is being put back", async () => {
		const { swapped, log } = await start({
			mountThrows: {
				react: 2
			}
		});
		let pendings = 0;
		swapped.swap.onPendingChange((pending) => {
			if (pending === "solid" && ++pendings === 1) swapped.swap.switchTo("react");
		});
		await swapped.switchTo("react");
		for (let i = 0; i < 5; i++) await flush();
		expect(pendings).toBeGreaterThan(0);
		expect(swapped.current()).toBe("solid");
		expect(shown()).toEqual([
			"view solid"
		]);
		expect(log.filter((line) => line.startsWith("mount throws"))).toEqual([
			"mount throws react",
			"mount throws react"
		]);
		expect(swapped.note.textContent).toBe("Couldn't switch to React. Try again.");
	});

	it("swaps again on the next ask after a status listener throws as a swap starts", async () => {
		const { swapped } = await start();
		let throws = 1;
		swapped.swap.onPendingChange(() => {
			if (throws > 0) {
				throws--;
				throw new Error("listener");
			}
		});
		swapped.swap.switchTo("react");
		await flush();
		expect(unhandled).toEqual([]);

		swapped.swap.switchTo("react");
		await flush();
		await flush();
		expect(swapped.current()).toBe("react");
	});

	it("carries out an ask a status listener makes just before onSwitch throws", async () => {
		let throws = 0;
		const { swapped } = await start({}, () => {
			if (throws > 0) {
				throws--;
				throw new Error("replaceState refused");
			}
		});
		let asked = false;
		swapped.swap.onPendingChange((pending) => {
			if (!asked && pending === null && swapped.current() === "react") {
				asked = true;
				swapped.swap.switchTo("solid");
			}
		});
		throws = 1;
		await swapped.switchTo("react");
		expect(asked).toBe(true);
		expect(swapped.current()).toBe("solid");
		expect(errors.some((args) => String(args[1]).includes("replaceState refused"))).toBe(true);
	});
});

describe("the portal going away or failing outright", () => {
	it("mounts nothing for a load that finishes after unmount()", async () => {
		let release!: () => void;
		const faults: IFaults = {
			reactGate: new Promise<void>((resolve) => {
				release = resolve;
			})
		};
		const { swapped, log } = await start(faults);
		const asked = swapped.switchTo("react");
		swapped.unmount();
		release();
		await asked;
		await flush();
		expect(log).toEqual([
			"mount solid",
			"unmount solid"
		]);
		expect(swapped.current()).toBeUndefined();
		expect(element.childElementCount).toBe(0);
	});

	it("says the view didn't load when the failed card itself throws, and clears it once a view mounts", async () => {
		const { swapped } = await start({
			mountThrows: {
				solid: 1
			},
			failThrows: 1
		});
		expect(swapped.current()).toBeUndefined();
		expect(element.textContent).toBe("The portal's view didn't load. Reload the page to try again.");
		expect(errors.some((args) => String(args[1]).includes("fail card"))).toBe(true);

		await swapped.switchTo("solid");
		expect(shown()).toEqual([
			"view solid"
		]);
		expect(element.childElementCount).toBe(1);
	});
});
