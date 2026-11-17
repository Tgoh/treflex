import type { IRuntimeInternal } from "../../src/Runtime/internals";
import type { IActionGenerator } from "../../src/Types/IAction";
import type { IRuntimeEventOf } from "../../src/Types/IRuntimeEvent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openResource } from "../../src/Effects/openResource";
import { resource } from "../../src/Effects/resource";
import { receiver } from "../../src/Runtime/receiver";
import { createTestRuntime } from "../../src/Testing/createTestRuntime";
import { isEnded } from "../../src/Types/IResource";

declare module "../../src/Registries/IResourceRegistry" {
	interface IResourceTypeRegistry {
		"stub/upload": {
			Methods: {
				upload(id: string): string;
			};
			Supply: readonly string[];
			SupplyResponse: {
				Id: string;
			}[];
			Value: string;
		};
	}
	interface IResourceRegistry {
		"Stub/Upload": {
			Type: "stub/upload";
		};
		"Stub/Other": {
			Type: "stub/upload";
		};
	}
}

type IDialog = {
	$Id: string;
	Log: string[];
};

const DialogReceiver = receiver<IDialog>("StubDialogReceiver")({
	*"Stub/Upload"(draft, e) {
		if (isEnded(e)) {
			draft.Log.push(`ended:${e.$Ended.Reason}`);
		}
	}
});

function* open(draft: IDialog): IActionGenerator {
	yield* openResource(draft, "Stub/Upload", DialogReceiver, {
		Type: "stub/upload"
	});
}

function* upload(draft: IDialog, id: string): IActionGenerator {
	const guid = yield* resource(draft, "Stub/Upload").upload(id);
	draft.Log.push(guid ?? "none");
}

const initial = (): IDialog => ({
	$Id: "dialog",
	Log: []
});

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("createTestRuntime: resources", () => {
	it("records rows and connects nothing, even with a real type registered", async () => {
		const runtime = createTestRuntime(initial());
		const setup = vi.fn();
		runtime.registerResourceType("stub/upload", setup);
		runtime.registerReceiver(DialogReceiver);
		await runtime.dispatch(open, "dialog");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(setup).not.toHaveBeenCalled();
		expect(runtime.resources(runtime.state)).toEqual([
			{
				Key: "Stub/Upload",
				OwnerId: "dialog",
				Params: {
					Type: "stub/upload"
				},
				ReceiverId: "StubDialogReceiver",
				ResumeFrom: null
			}
		]);
		runtime.dispose();
	});

	it("answers a method from its stub only when a row exists, and takes the not-open path otherwise", async () => {
		const calls: unknown[] = [];
		const runtime = createTestRuntime(
			initial(),
			{},
			{
				resources: {
					methods: {
						"Stub/Upload": {
							upload: (
								ctx: {
									ownerId: string;
								},
								id: string
							) => {
								calls.push([
									ctx.ownerId,
									id
								]);
								return `guid-${id}`;
							}
						}
					}
				}
			}
		);
		const diags: IRuntimeEventOf<"diag">[] = [];
		runtime.on("diag", (d) => diags.push(d));
		await runtime.dispatch(upload, "dialog", "f1");
		expect(runtime.state.Log).toEqual([
			"none"
		]);
		expect(diags.map((d) => d.code)).toContain("resource/not-open");
		await runtime.dispatch(open, "dialog");
		await runtime.dispatch(upload, "dialog", "f2");
		expect(runtime.state.Log).toEqual([
			"none",
			"guid-f2"
		]);
		expect(calls).toEqual([
			[
				"dialog",
				"f2"
			]
		]);
		runtime.dispose();
	});

	it("throws for an unstubbed method or supply on a cell with a row", async () => {
		const runtime = createTestRuntime(initial());
		await runtime.dispatch(open, "dialog");
		await expect(runtime.dispatch(upload, "dialog", "f1")).rejects.toThrow(/has no stub/);
		await expect(
			runtime.supplyResource("dialog", "Stub/Upload", [
				"a"
			])
		).rejects.toThrow(/has no stub/);
		runtime.dispose();
	});

	it("answers supplies, exposes a value and reports a status from stubs, gated on the row", async () => {
		const runtime = createTestRuntime(
			initial(),
			{},
			{
				resources: {
					supplies: {
						"Stub/Upload": (
							_ctx: {
								ownerId: string;
							},
							files: readonly string[]
						) =>
							files.map((f) => ({
								Id: f
							}))
					},
					exposes: {
						"Stub/Upload": "blob:preview"
					},
					statuses: {
						"Stub/Other": {
							State: "live",
							Detail: "retrying"
						}
					}
				}
			}
		);
		const manager = (runtime as IRuntimeInternal<IDialog>).get("runtime/resources");
		expect(manager.status("Stub/Upload", "dialog")).toEqual({
			State: "none"
		});
		expect(manager.value("Stub/Upload", "dialog")).toBeUndefined();
		await runtime.dispatch(open, "dialog");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(manager.status("Stub/Upload", "dialog")).toEqual({
			State: "live"
		});
		expect(manager.value("Stub/Upload", "dialog")).toBe("blob:preview");
		expect(
			await runtime.supplyResource("dialog", "Stub/Upload", [
				"a",
				"b"
			])
		).toEqual([
			{
				Id: "a"
			},
			{
				Id: "b"
			}
		]);
		function* openOther(draft: IDialog): IActionGenerator {
			yield* openResource(draft, "Stub/Other", {
				Type: "stub/upload"
			});
		}
		await runtime.dispatch(openOther, "dialog");
		expect(manager.status("Stub/Other", "dialog")).toEqual({
			State: "live",
			Detail: "retrying"
		});
		runtime.dispose();
	});

	it("reads a stubless cell with a row as paused", async () => {
		const runtime = createTestRuntime(initial());
		await runtime.dispatch(open, "dialog");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect((runtime as IRuntimeInternal<IDialog>).get("runtime/resources").status("Stub/Upload", "dialog")).toEqual({
			State: "pending",
			Waiting: "paused"
		});
		runtime.dispose();
	});

	it("lets a test dispatch the end notice straight to the receiver", async () => {
		const runtime = createTestRuntime(initial());
		await runtime.dispatch(
			DialogReceiver.handle,
			"dialog",
			{
				Type: "Stub/Upload",
				$Ended: {
					Reason: "lost"
				}
			},
			{
				publisher: {
					Id: "dialog"
				}
			}
		);
		expect(runtime.state.Log).toEqual([
			"ended:lost"
		]);
		runtime.dispose();
	});
});
