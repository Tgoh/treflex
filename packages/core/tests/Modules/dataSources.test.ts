import type { IActionGenerator } from "../../src/Types/IAction";
import { describe, expect, it, vi } from "vitest";
import { registerDataSource } from "../../src/Effects/registerDataSource";
import { unregisterDataSource } from "../../src/Effects/unregisterDataSource";
import { getData, getDataGlobal } from "../../src/Reads/getData";
import { createRuntime } from "../../src/Runtime/createRuntime";
import { seat } from "../../src/Runtime/draftNode";
import * as reactive from "../reactive";
import { rootSetState, treeWrite } from "../testHelpers";

const registerDS = registerDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string,
	data?: {
		$Id: string;
	}
) => Generator<any, void, any>;
const unregisterDS = unregisterDataSource as unknown as (
	owner: {
		$Id: string;
	},
	key: string
) => Generator<any, void, any>;
const getDS = getData as unknown as (
	from: {
		$Id: string;
	},
	key: string
) => Generator<any, any, any>;
const getDSGlobal = getDataGlobal as unknown as (key: string) => Generator<any, any, any>;

async function withRuntime<T extends object>(
	initial: T,
	body: (runtime: ReturnType<typeof createRuntime<T>>) => Promise<void>
): Promise<void> {
	await reactive.root(async (dispose) => {
		try {
			await body(createRuntime(initial));
		} finally {
			dispose();
		}
	});
}

async function register(
	runtime: any,
	owner: {
		$Id: string;
	},
	key: string,
	data?: {
		$Id: string;
	}
): Promise<void> {
	function* impl(_d: any): IActionGenerator {
		if (data) {
			yield* registerDS(owner, key, data);
		} else {
			yield* registerDS(owner, key);
		}
	}
	return runtime.processAction(
		impl as any,
		() => runtime.state,
		rootSetState(runtime),
		() =>
			(
				runtime.state as {
					$Id: string;
				}
			).$Id
	);
}

async function read(
	runtime: any,
	key: string,
	options?: {
		from?: {
			$Id: string;
		};
	}
): Promise<any> {
	function* impl(_d: any): IActionGenerator<any> {
		return options?.from ? yield* getDS(options.from, key) : yield* getDSGlobal(key);
	}
	return runtime.processAction(
		impl as any,
		() => runtime.state,
		rootSetState(runtime),
		() => "test-reader"
	);
}

async function unregister(
	runtime: any,
	owner: {
		$Id: string;
	},
	key: string
): Promise<void> {
	function* impl(_d: any): IActionGenerator {
		yield* unregisterDS(owner, key);
	}
	return runtime.processAction(
		impl as any,
		() => runtime.state,
		rootSetState(runtime),
		() =>
			(
				runtime.state as {
					$Id: string;
				}
			).$Id
	);
}

describe("dataSources", () => {
	describe("self-registration (owner === data)", () => {
		it("a descendant resolves to a self-registered ancestor", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					Workspace: {
						$Id: "Workspace",
						Marker: "workspace-state",
						Page: {
							$Id: "Page"
						}
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Workspace"
						},
						"Workspace"
					);
					const result = await read(runtime, "Workspace", {
						from: {
							$Id: "Page"
						}
					});
					expect(result).toMatchObject({
						Marker: "workspace-state"
					});
				}
			);
		});

		it("a self-registered entity resolves itself when from === self", async () => {
			await withRuntime(
				{
					$Id: "Workspace",
					Marker: "workspace-state"
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Workspace"
						},
						"Workspace"
					);
					const result = await read(runtime, "Workspace", {
						from: {
							$Id: "Workspace"
						}
					});
					expect(result).toMatchObject({
						Marker: "workspace-state"
					});
				}
			);
		});
	});

	describe("value snapshots (the read ruling)", () => {
		it("an action-side getData result is detached — later writes do not reach it; a re-yield does", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					Theme: {
						$Id: "Theme",
						Hue: 1
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Theme"
						},
						"Theme"
					);
					const seen: number[] = [];
					function* holder(draft: any): IActionGenerator {
						const held = yield* getDSGlobal("Theme");
						seen.push(held.Hue);
						draft.Theme.Hue = 2;
						seen.push(held.Hue);
						const fresh = yield* getDSGlobal("Theme");
						seen.push(fresh.Hue);
					}
					await runtime.processAction(
						holder as any,
						() => runtime.state,
						rootSetState(runtime),
						() => "Platform"
					);
					expect(seen).toEqual([
						1,
						1,
						2
					]);
					expect((runtime.state as any).Theme.Hue).toBe(2);
				}
			);
		});

		it("writing through a getData result throws in dev — lookup is a read; the draft is the write surface", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					Theme: {
						$Id: "Theme",
						Hue: 1
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Theme"
						},
						"Theme"
					);
					let thrown: unknown = null;
					function* writer(_draft: any): IActionGenerator {
						const held = yield* getDSGlobal("Theme");
						try {
							held.Hue = 99;
						} catch (e) {
							thrown = e;
						}
					}
					await runtime.processAction(
						writer as any,
						() => runtime.state,
						rootSetState(runtime),
						() => "Platform"
					);
					expect(thrown).toBeInstanceOf(TypeError);
					expect((runtime.state as any).Theme.Hue).toBe(1);
				}
			);
		});
	});

	describe("strict ancestor resolution", () => {
		// The walk climbs the consumer's own path, nothing else. A registration
		// in a cousin or descendant branch is never found.
		it("a parent does NOT resolve to an owner in its own subtree", async () => {
			await withRuntime(
				{
					$Id: "Root",
					A: {
						$Id: "A",
						D: {
							$Id: "D",
							Marker: "d"
						}
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "D"
						},
						"X"
					);
					const result = await read(runtime, "X", {
						from: {
							$Id: "A"
						}
					});
					expect(result).toBeUndefined();
				}
			);
		});

		it("a cousin does NOT resolve across a shared ancestor", async () => {
			await withRuntime(
				{
					$Id: "Root",
					Branch: {
						$Id: "Branch",
						Provider: {
							$Id: "Provider",
							Marker: "p"
						},
						Consumer: {
							$Id: "Consumer"
						}
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Provider"
						},
						"X"
					);
					const result = await read(runtime, "X", {
						from: {
							$Id: "Consumer"
						}
					});
					expect(result).toBeUndefined();
				}
			);
		});
	});

	describe("owner and data distinct", () => {
		const buildState = () => ({
			$Id: "Platform",
			ThemeData: {
				$Id: "ThemeData",
				Marker: "platform-theme"
			},
			Workspace: {
				$Id: "Workspace",
				WorkspaceThemeData: {
					$Id: "WorkspaceThemeData",
					Marker: "workspace-theme"
				},
				Page: {
					$Id: "Page"
				}
			},
			Outside: {
				$Id: "Outside"
			}
		});

		it("a consumer resolves to the owner's data, wherever the data lives", async () => {
			await withRuntime(buildState(), async (runtime) => {
				await register(
					runtime,
					{
						$Id: "Platform"
					},
					"Theme",
					{
						$Id: "ThemeData"
					}
				);
				const result = await read(runtime, "Theme", {
					from: {
						$Id: "Page"
					}
				});
				expect(result).toMatchObject({
					Marker: "platform-theme"
				});
			});
		});

		it("a nearer owner overrides a more distant one", async () => {
			await withRuntime(buildState(), async (runtime) => {
				await register(
					runtime,
					{
						$Id: "Platform"
					},
					"Theme",
					{
						$Id: "ThemeData"
					}
				);
				await register(
					runtime,
					{
						$Id: "Workspace"
					},
					"Theme",
					{
						$Id: "WorkspaceThemeData"
					}
				);
				const inside = await read(runtime, "Theme", {
					from: {
						$Id: "Page"
					}
				});
				expect(inside).toMatchObject({
					Marker: "workspace-theme"
				});
				const outside = await read(runtime, "Theme", {
					from: {
						$Id: "Outside"
					}
				});
				expect(outside).toMatchObject({
					Marker: "platform-theme"
				});
			});
		});

		it("the global read resolves to the owner closest to the root", async () => {
			await withRuntime(buildState(), async (runtime) => {
				await register(
					runtime,
					{
						$Id: "Platform"
					},
					"Theme",
					{
						$Id: "ThemeData"
					}
				);
				await register(
					runtime,
					{
						$Id: "Workspace"
					},
					"Theme",
					{
						$Id: "WorkspaceThemeData"
					}
				);
				const result = await read(runtime, "Theme");
				expect(result).toMatchObject({
					Marker: "platform-theme"
				});
			});
		});
	});

	describe("missing", () => {
		it("returns undefined for an unregistered key", async () => {
			await withRuntime(
				{
					$Id: "Platform"
				},
				async (runtime) => {
					expect(await read(runtime, "Nope")).toBeUndefined();
				}
			);
		});

		it("warns and returns undefined when from is not in the state tree", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					Data: {
						$Id: "Data",
						Marker: "d"
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Platform"
						},
						"Theme",
						{
							$Id: "Data"
						}
					);
					const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
					try {
						const result = await read(runtime, "Theme", {
							from: {
								$Id: "Ghost"
							}
						});
						expect(result).toBeUndefined();
						expect(warnSpy).toHaveBeenCalled();
						expect(warnSpy.mock.calls[0][0]).toContain("not in the state tree");
					} finally {
						warnSpy.mockRestore();
					}
				}
			);
		});

		// The anchor obligation does not depend on the key having a
		// registration. Gated on the bucket, the commonest first-run case,
		// an unregistered key read from an object outside the tree, would
		// resolve undefined and say nothing.
		it("warns for an anchor outside the tree even when the key has no registration at all", async () => {
			await withRuntime(
				{
					$Id: "Platform"
				},
				async (runtime) => {
					const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
					try {
						const result = await read(runtime, "NeverRegistered", {
							from: {
								$Id: "Ghost"
							}
						});
						expect(result).toBeUndefined();
						expect(warnSpy).toHaveBeenCalled();
						expect(warnSpy.mock.calls[0][0]).toContain("not in the state tree");
					} finally {
						warnSpy.mockRestore();
					}
				}
			);
		});
	});

	describe("the two reads never substitute for one another", () => {
		const twoOwners = {
			$Id: "Platform",
			Global: {
				$Id: "Global",
				Marker: "platform-theme"
			},
			Workspace: {
				$Id: "Workspace",
				Local: {
					$Id: "Local",
					Marker: "workspace-theme"
				},
				Page: {
					$Id: "Page"
				}
			}
		};

		async function registerBoth(runtime: any): Promise<void> {
			await register(
				runtime,
				{
					$Id: "Platform"
				},
				"Theme",
				{
					$Id: "Global"
				}
			);
			await register(
				runtime,
				{
					$Id: "Workspace"
				},
				"Theme",
				{
					$Id: "Local"
				}
			);
		}

		it("an empty anchor warns and resolves undefined rather than widening to the root-most owner", async () => {
			await withRuntime(twoOwners, async (runtime) => {
				await registerBoth(runtime);
				const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
				try {
					const result = await read(runtime, "Theme", {
						from: {
							$Id: ""
						}
					});
					expect(result).toBeUndefined();
					expect(warnSpy).toHaveBeenCalled();
					expect(warnSpy.mock.calls[0][0]).toContain("not in the state tree");
					expect(warnSpy.mock.calls[0][0]).toContain("getData");
				} finally {
					warnSpy.mockRestore();
				}
			});
		});

		it("the global read resolves the root-most owner", async () => {
			await withRuntime(twoOwners, async (runtime) => {
				await registerBoth(runtime);
				const result = await read(runtime, "Theme");
				expect(result).toMatchObject({
					Marker: "platform-theme"
				});
			});
		});

		it("a scoped read resolves its own lineage, never the root-most owner", async () => {
			await withRuntime(twoOwners, async (runtime) => {
				await registerBoth(runtime);
				const result = await read(runtime, "Theme", {
					from: {
						$Id: "Page"
					}
				});
				expect(result).toMatchObject({
					Marker: "workspace-theme"
				});
			});
		});
	});

	describe("re-registration", () => {
		it("an owner re-registering a key re-points the data, and warns", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					V1: {
						$Id: "V1",
						Marker: "v1"
					},
					V2: {
						$Id: "V2",
						Marker: "v2"
					}
				},
				async (runtime) => {
					const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
					try {
						await register(
							runtime,
							{
								$Id: "Platform"
							},
							"Theme",
							{
								$Id: "V1"
							}
						);
						await register(
							runtime,
							{
								$Id: "Platform"
							},
							"Theme",
							{
								$Id: "V2"
							}
						);
						expect(warnSpy).toHaveBeenCalled();
						expect(warnSpy.mock.calls[0][0]).toContain("already owns");
						const result = await read(runtime, "Theme");
						expect(result).toMatchObject({
							Marker: "v2"
						});
					} finally {
						warnSpy.mockRestore();
					}
				}
			);
		});

		it("different owners registering the same key do not warn", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					A: {
						$Id: "A",
						AData: {
							$Id: "AData",
							Marker: "a"
						}
					},
					B: {
						$Id: "B",
						BData: {
							$Id: "BData",
							Marker: "b"
						}
					}
				},
				async (runtime) => {
					const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
					try {
						await register(
							runtime,
							{
								$Id: "A"
							},
							"Theme",
							{
								$Id: "AData"
							}
						);
						await register(
							runtime,
							{
								$Id: "B"
							},
							"Theme",
							{
								$Id: "BData"
							}
						);
						expect(warnSpy).not.toHaveBeenCalled();
					} finally {
						warnSpy.mockRestore();
					}
				}
			);
		});
	});

	describe("lifetime", () => {
		it("drops the registration when the owner leaves the tree", async () => {
			await withRuntime(
				{
					$Id: "Root",
					Scopes: [
						{
							$Id: "Scope"
						}
					],
					Data: {
						$Id: "Data",
						Marker: "d"
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Scope"
						},
						"Theme",
						{
							$Id: "Data"
						}
					);
					expect(await read(runtime, "Theme")).toMatchObject({
						Marker: "d"
					});

					treeWrite(runtime, (s: any) => {
						s.Scopes.splice(0, 1);
					});
					expect(await read(runtime, "Theme")).toBeUndefined();
				}
			);
		});

		it("keeps the registration when only the data leaves, and reconnects when it returns", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					Slots: [
						{
							$Id: "Slot",
							Marker: "v1"
						}
					]
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Platform"
						},
						"Theme",
						{
							$Id: "Slot"
						}
					);
					expect(await read(runtime, "Theme")).toMatchObject({
						Marker: "v1"
					});

					treeWrite(runtime, (s: any) => {
						s.Slots.splice(0, 1);
					});
					expect(await read(runtime, "Theme")).toBeUndefined();

					treeWrite(runtime, (s: any) => {
						seat(s.Slots, s.Slots.length, {
							$Id: "Slot",
							Marker: "v2"
						});
					});
					expect(await read(runtime, "Theme")).toMatchObject({
						Marker: "v2"
					});
				}
			);
		});
	});

	describe("unregister", () => {
		it("retracts a registration, and a live lookup re-resolves", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					Data: {
						$Id: "Data",
						Marker: "d"
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Platform"
						},
						"Theme",
						{
							$Id: "Data"
						}
					);
					expect(await read(runtime, "Theme")).toMatchObject({
						Marker: "d"
					});

					await unregister(
						runtime,
						{
							$Id: "Platform"
						},
						"Theme"
					);
					expect(await read(runtime, "Theme")).toBeUndefined();
				}
			);
		});

		it("a consumer falls back to a higher owner when the nearer one unregisters", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					PlatformTheme: {
						$Id: "PlatformTheme",
						Marker: "platform"
					},
					Workspace: {
						$Id: "Workspace",
						WorkspaceTheme: {
							$Id: "WorkspaceTheme",
							Marker: "workspace"
						},
						Page: {
							$Id: "Page"
						}
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "Platform"
						},
						"Theme",
						{
							$Id: "PlatformTheme"
						}
					);
					await register(
						runtime,
						{
							$Id: "Workspace"
						},
						"Theme",
						{
							$Id: "WorkspaceTheme"
						}
					);
					expect(
						await read(runtime, "Theme", {
							from: {
								$Id: "Page"
							}
						})
					).toMatchObject({
						Marker: "workspace"
					});

					await unregister(
						runtime,
						{
							$Id: "Workspace"
						},
						"Theme"
					);
					expect(
						await read(runtime, "Theme", {
							from: {
								$Id: "Page"
							}
						})
					).toMatchObject({
						Marker: "platform"
					});
				}
			);
		});

		it("unregistering one owner leaves another owner's registration intact", async () => {
			await withRuntime(
				{
					$Id: "Platform",
					A: {
						$Id: "A",
						AData: {
							$Id: "AData",
							Marker: "a"
						}
					},
					B: {
						$Id: "B",
						BData: {
							$Id: "BData",
							Marker: "b"
						}
					}
				},
				async (runtime) => {
					await register(
						runtime,
						{
							$Id: "A"
						},
						"Theme",
						{
							$Id: "AData"
						}
					);
					await register(
						runtime,
						{
							$Id: "B"
						},
						"Theme",
						{
							$Id: "BData"
						}
					);
					await unregister(
						runtime,
						{
							$Id: "A"
						},
						"Theme"
					);
					expect(
						await read(runtime, "Theme", {
							from: {
								$Id: "A"
							}
						})
					).toBeUndefined();
					expect(
						await read(runtime, "Theme", {
							from: {
								$Id: "B"
							}
						})
					).toMatchObject({
						Marker: "b"
					});
				}
			);
		});
	});
});
