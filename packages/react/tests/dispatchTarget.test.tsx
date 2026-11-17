import type { ReactNode } from "react";
import type { IActionGenerator, IAskEntry, IAskId, IEntity, ILocation, IRecord, ISelectorGenerator } from "treflex";
import type { IEntityRef } from "../src";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createContext, Suspense, startTransition, useContext, useEffect, useRef, useState } from "react";
import { AnswerOutsideOwnerError, answer, ask, createRuntime, entity, open, pendingAsks, transient } from "treflex";
import { rawOf } from "treflex/internal";
import { afterEach, describe, expect, it } from "vitest";
import { createEntityFeature, TreflexProvider, useDispatch, useEntity, useLocate } from "../src";
import { getFrames } from "../src/createFrames";

interface IPhone extends IEntity {
	Number: string;
}

interface IContact {
	Name: string;
	Address: {
		Street: string;
	};
	Phones: IPhone[];
}

interface IRec extends IEntity {
	Contact: IContact;
	Value: number;
}

interface IDialog extends IEntity {
	Contact: IContact;
}

interface IPair extends IEntity {
	A: IRec;
	B: IRec;
}

interface IRoot extends IEntity {
	Rec: IRec;
	Dialog: IDialog | null;
	Result: string | null;
}

const contact = (phones: IPhone[] = []): IContact => ({
	Name: "Ada",
	Address: {
		Street: "1 Main"
	},
	Phones: phones
});

const seed = (): IRoot => ({
	$Id: "root",
	Rec: {
		$Id: "rec",
		Contact: contact([
			{
				$Id: "p1",
				Number: "1"
			}
		]),
		Value: 0
	},
	Dialog: null,
	Result: null
});

function* setFieldAction(draft: any, at: ILocation, field: string, value: unknown): IActionGenerator {
	let node: any = at.TransientName === undefined ? draft : yield* transient(draft, at.TransientName, {});
	for (const key of at.Path) {
		node = node?.[key];
	}
	if (node !== null && typeof node === "object") {
		node[field] = value;
	}
}

function* bump(draft: IRec): IActionGenerator {
	draft.Value++;
}

function* openDialog(draft: IRoot): IActionGenerator {
	draft.Dialog = yield* entity({
		Contact: contact()
	});
}

function* closeDialog(draft: IRoot): IActionGenerator {
	draft.Dialog = null;
}

const Screen = createEntityFeature<IRoot>("tests/dispatchTarget/Screen")({
	openDialog,
	closeDialog
});
const Rec = createEntityFeature<IRec>("tests/dispatchTarget/Rec")({
	bump
});
const Dialog = createEntityFeature<IDialog>("tests/dispatchTarget/Dialog")({});
const Phone = createEntityFeature<IPhone>("tests/dispatchTarget/Phone")({});

const FormContext = createContext<unknown>(undefined);

function FormProvider(props: { state: unknown; children: ReactNode }) {
	return <FormContext.Provider value={props.state}>{props.children}</FormContext.Provider>;
}

function useFormField() {
	const state = useContext(FormContext) as Record<string, unknown> | undefined;
	const locate = useLocate();
	const dispatch = useDispatch();
	const set = (field: string, value: unknown) => {
		const at = locate(state);
		if (!at) {
			return;
		}
		return dispatch(setFieldAction, at.EntityId, at, field, value);
	};
	return {
		value: (field: string) => state?.[field],
		set
	};
}

const held = new Map<string, (value: unknown) => Promise<void> | undefined>();
const blurs: unknown[] = [];

function TextField(props: { field: string; label: string; blurValue?: string }) {
	const form = useFormField();
	held.set(props.label, (value) => form.set(props.field, value));
	const blur = useRef(() => {});
	blur.current = () => {
		if (props.blurValue !== undefined) {
			blurs.push(form.set(props.field, props.blurValue));
		}
	};
	useEffect(() => () => blur.current(), []);
	return (
		<input
			aria-label={props.label}
			value={String(form.value(props.field) ?? "")}
			onChange={(e) => void form.set(props.field, e.target.value)}
		/>
	);
}

afterEach(() => {
	cleanup();
	held.clear();
	blurs.length = 0;
});

function build() {
	const runtime = createRuntime<IRoot>(seed());
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: [
		string,
		unknown
	][] = [];
	runtime.on("diag", (event) =>
		diags.push([
			event.code,
			(
				event.data as {
					cause?: unknown;
				}
			).cause
		])
	);
	const changes = () => records.flatMap((r) => (r.Kind === "step" ? r.Changes.map((c) => c.Path.join(".")) : []));
	return {
		runtime,
		records,
		diags,
		changes
	};
}

describe("React's provider dispatches with its ref as the node", () => {
	function mountRec(runtime: ReturnType<typeof build>["runtime"], state: IEntityRef<IRec>) {
		let bound!: ReturnType<typeof Rec.use>;
		const Body = Rec.provider(() => {
			bound = Rec.use();
			return null;
		});
		render(
			<TreflexProvider value={runtime}>
				<Body state={state} />
			</TreflexProvider>
		);
		return () => bound;
	}

	it("dispatches through a parent's ref, and a literal { $Id } addresses by the $Id", async () => {
		const { runtime, diags } = build();
		const ref = (
			getFrames(runtime).root() as {
				Rec: IEntityRef<IRec>;
			}
		).Rec;
		const viaRef = mountRec(runtime, ref);
		await act(() => viaRef().bump());
		cleanup();
		const viaLiteral = mountRec(runtime, {
			$Id: "rec"
		});
		await act(() => viaLiteral().bump());
		expect(runtime.state.Rec.Value).toBe(2);
		expect(diags).toEqual([]);
	});

	it("refuses a superseded ref, and a ref from another runtime, naming the cause", async () => {
		const { runtime, diags } = build();
		const stale = (
			getFrames(runtime).root() as {
				Rec: IEntityRef<IRec>;
			}
		).Rec;
		rawOf(runtime.state).Rec = {
			...seed().Rec,
			Value: 10
		};
		(runtime as any).get("runtime/writeGateway").resync();
		const viaStale = mountRec(runtime, stale);
		await expect(viaStale().bump()).rejects.toThrow(/superseded node/);
		cleanup();

		const other = createRuntime<IRoot>(seed());
		const foreign = (
			getFrames(other).root() as {
				Rec: IEntityRef<IRec>;
			}
		).Rec;
		const viaForeign = mountRec(runtime, foreign);
		await expect(viaForeign().bump()).rejects.toThrow(/not a node of this runtime's tree/);

		expect(diags).toEqual([
			[
				"dispatch/node-mismatch",
				"superseded"
			],
			[
				"dispatch/node-mismatch",
				"foreign"
			]
		]);
		expect(runtime.state.Rec.Value).toBe(10);
		other.dispose();
	});

	it("refuses a copy of a view, at the provider and through useDispatch", async () => {
		const { runtime, diags } = build();
		const view = getFrames(runtime).entity("rec") as IEntityRef<IRec>;
		const copy = {
			...view
		};
		const viaCopy = mountRec(runtime, copy);
		await expect(viaCopy().bump()).rejects.toThrow(/a copy or other plain value carrying the \$Id/);
		cleanup();

		let dispatch!: ReturnType<typeof useDispatch>;
		const Probe = () => {
			dispatch = useDispatch();
			return null;
		};
		render(
			<TreflexProvider value={runtime}>
				<Probe />
			</TreflexProvider>
		);
		await expect(dispatch(bump, copy)).rejects.toThrow(/not a node of this runtime's tree/);
		await act(() => dispatch(bump, view));
		expect(runtime.state.Rec.Value).toBe(1);
		expect(diags).toEqual([
			[
				"dispatch/node-mismatch",
				"foreign"
			]
		]);
	});

	it("keeps an instance a handler captured on its own entity after a committed swap to another", async () => {
		const runtime = createRuntime<IPair>({
			$Id: "pair",
			A: {
				$Id: "a",
				Contact: contact(),
				Value: 0
			},
			B: {
				$Id: "b",
				Contact: contact(),
				Value: 0
			}
		});
		let captured: ReturnType<typeof Rec.use> | undefined;
		const Body = Rec.provider(() => {
			const rec = Rec.use();
			captured ??= rec;
			return <p>rec {rec.state.$Id}</p>;
		});
		let swap!: (id: string) => void;
		function Host() {
			const [id, setId] = useState("a");
			swap = setId;
			return (
				<Body
					state={{
						$Id: id
					}}
				/>
			);
		}
		render(
			<TreflexProvider value={runtime}>
				<Host />
			</TreflexProvider>
		);
		await act(async () => {
			swap("b");
		});
		expect(screen.getByText("rec b")).toBeTruthy();

		await act(() => captured!.bump());

		expect([
			runtime.state.A.Value,
			runtime.state.B.Value
		]).toEqual([
			1,
			0
		]);
	});

	it("dispatches at the entity the committed render shows, not one a suspended render swapped in", async () => {
		const runtime = createRuntime<IPair>({
			$Id: "pair",
			A: {
				$Id: "a",
				Contact: contact(),
				Value: 0
			},
			B: {
				$Id: "b",
				Contact: contact(),
				Value: 0
			}
		});
		const never = new Promise<never>(() => {});
		let shown!: ReturnType<typeof Rec.use>;
		const Body = Rec.provider(() => {
			const rec = Rec.use();
			if (rec.state.$Id === "b") {
				throw never;
			}
			shown = rec;
			return <p>rec {rec.state.$Id}</p>;
		});
		let swap!: (id: string) => void;
		function Host() {
			const [id, setId] = useState("a");
			swap = setId;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Body
						state={{
							$Id: id
						}}
					/>
				</Suspense>
			);
		}
		render(
			<TreflexProvider value={runtime}>
				<Host />
			</TreflexProvider>
		);
		await act(async () => {
			startTransition(() => swap("b"));
		});
		expect(screen.getByText("rec a")).toBeTruthy();

		await act(() => shown.bump());

		expect(runtime.state.A.Value).toBe(1);
		expect(runtime.state.B.Value).toBe(0);
	});

	it("dispatches at the committed ref of its entity, not a stale one a suspended render passed", async () => {
		const runtime = createRuntime<IPair>({
			$Id: "pair",
			A: {
				$Id: "a",
				Contact: contact(),
				Value: 0
			},
			B: {
				$Id: "b",
				Contact: contact(),
				Value: 0
			}
		});
		const frames = getFrames(runtime);
		const refOfA = () =>
			(
				frames.root() as {
					A: IEntityRef<IRec>;
				}
			).A;
		const stale = refOfA();
		rawOf(runtime.state).A = {
			$Id: "a",
			Contact: contact(),
			Value: 0
		};
		(runtime as any).get("runtime/writeGateway").resync();
		const current = refOfA();
		expect(current).not.toBe(stale);

		const never = new Promise<never>(() => {});
		let suspend = false;
		let shown!: ReturnType<typeof Rec.use>;
		const Body = Rec.provider(() => {
			const rec = Rec.use();
			if (suspend) {
				throw never;
			}
			shown = rec;
			return <p>rec {rec.state.$Id}</p>;
		});
		let pass!: (ref: IEntityRef<IRec>) => void;
		function Host() {
			const [ref, setRef] = useState(current);
			pass = setRef;
			return (
				<Suspense fallback={<p>loading</p>}>
					<Body state={ref} />
				</Suspense>
			);
		}
		const { diags } = (() => {
			const seen: string[] = [];
			runtime.on("diag", (event) => seen.push(event.code));
			return {
				diags: seen
			};
		})();
		render(
			<TreflexProvider value={runtime}>
				<Host />
			</TreflexProvider>
		);
		suspend = true;
		await act(async () => {
			startTransition(() => pass(stale));
		});
		expect(screen.getByText("rec a")).toBeTruthy();

		await act(() => shown.bump());

		expect(runtime.state.A.Value).toBe(1);
		expect(diags).toEqual([]);
	});
});

describe("a React form binding over views and locate", () => {
	function mountScreen(runtime: ReturnType<typeof build>["runtime"]) {
		let screenUse!: ReturnType<typeof Screen.use>;
		const PhoneForm = Phone.provider(() => {
			const phone = Phone.use();
			return (
				<FormProvider state={phone.state}>
					<TextField field="Number" label={`phone-${phone.state.$Id}`} />
				</FormProvider>
			);
		});
		const RecForm = Rec.provider(() => {
			const rec = Rec.use();
			return (
				<FormProvider state={rec.state.Contact}>
					<TextField field="Name" label="name" />
					<FormProvider state={rec.state.Contact.Address}>
						<TextField field="Street" label="street" />
					</FormProvider>
					{rec.state.Contact.Phones.map((ref) => (
						<PhoneForm key={ref.$Id} state={ref} />
					))}
				</FormProvider>
			);
		});
		const DialogForm = Dialog.provider(() => {
			const dialog = Dialog.use();
			return (
				<FormProvider state={dialog.state.Contact}>
					<TextField field="Name" label="dialog-name" blurValue="lost" />
				</FormProvider>
			);
		});
		const Body = Screen.provider(() => {
			screenUse = Screen.use();
			const root = screenUse.state;
			return (
				<>
					<RecForm state={root.Rec} />
					{root.Dialog && <DialogForm state={root.Dialog} />}
				</>
			);
		});
		render(
			<TreflexProvider value={runtime}>
				<Body
					state={{
						$Id: "root"
					}}
				/>
			</TreflexProvider>
		);
		return () => screenUse;
	}

	it("writes nested fields of a view through one action on the entity, recording full paths, and an entity row on its own $Id", async () => {
		const { runtime, records, changes, diags } = build();
		mountScreen(runtime);

		await act(async () => {
			fireEvent.change(screen.getByLabelText("name"), {
				target: {
					value: "Bea"
				}
			});
		});
		await act(async () => {
			fireEvent.change(screen.getByLabelText("street"), {
				target: {
					value: "2 High"
				}
			});
		});
		await act(async () => {
			fireEvent.change(screen.getByLabelText("phone-p1"), {
				target: {
					value: "9"
				}
			});
		});

		expect(runtime.state.Rec.Contact.Name).toBe("Bea");
		expect(runtime.state.Rec.Contact.Phones[0]!.Number).toBe("9");
		expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("Bea");
		expect(changes()).toEqual([
			"Contact.Name",
			"Contact.Address.Street",
			"Number"
		]);
		expect(records.filter((r) => r.Kind === "action:start").map((r) => r.Kind === "action:start" && r.EntityId)).toEqual([
			"rec",
			"rec",
			"p1"
		]);
		expect(diags).toEqual([]);
	});

	it("stays silent for writes through a view whose node left with its dialog", async () => {
		const { runtime, records, diags } = build();
		const screenUse = mountScreen(runtime);
		await act(() => screenUse().openDialog());
		await act(async () => {
			fireEvent.change(screen.getByLabelText("dialog-name"), {
				target: {
					value: "typed"
				}
			});
		});
		expect(runtime.state.Dialog!.Contact.Name).toBe("typed");
		const stale = held.get("dialog-name")!;

		await act(() => screenUse().closeDialog());

		expect(blurs).toEqual([
			undefined
		]);
		expect(stale("after")).toBeUndefined();
		expect(runtime.state.Dialog).toBeNull();
		expect(records.filter((r) => r.Kind === "action:end" && r.Status === "errored")).toEqual([]);
		expect(diags).toEqual([]);
	});

	it("writes a node in a transient a selector returns, through the node its view was built from", async () => {
		const NAME = "Tests/ReactFormBinding/Draft";
		function* openDraft(draft: IRec): IActionGenerator {
			const node = yield* transient(draft, NAME, {
				Name: ""
			});
			node.Name = "start";
		}
		function* draftOf(draft: IRec) {
			return yield* transient(draft, NAME, {
				Name: ""
			});
		}
		const Drafted = createEntityFeature<IRec>("tests/dispatchTarget/Drafted")(
			{
				openDraft
			},
			{
				draftOf
			}
		);
		let rec!: ReturnType<typeof Drafted.use>;
		const Body = Drafted.provider(() => {
			rec = Drafted.use();
			return (
				<FormProvider state={rec.draftOf()}>
					<TextField field="Name" label="draft" />
				</FormProvider>
			);
		});
		const { runtime, changes, diags } = build();
		render(
			<TreflexProvider value={runtime}>
				<Body
					state={{
						$Id: "rec"
					}}
				/>
			</TreflexProvider>
		);
		await act(() => rec.openDraft());
		await act(async () => {
			fireEvent.change(screen.getByLabelText("draft"), {
				target: {
					value: "typed"
				}
			});
		});

		expect((screen.getByLabelText("draft") as HTMLInputElement).value).toBe("typed");
		expect(changes().at(-1)).toBe(`TransientState.rec.${NAME}.Name`);
		expect(diags).toEqual([]);
	});

	it("throws for a form handed a copy of a view", () => {
		const { runtime } = build();
		const Body = Rec.provider(() => {
			const rec = Rec.use();
			return (
				<FormProvider
					state={{
						...rec.state.Contact
					}}
				>
					<TextField field="Name" label="copied" />
				</FormProvider>
			);
		});
		render(
			<TreflexProvider value={runtime}>
				<Body
					state={{
						$Id: "rec"
					}}
				/>
			</TreflexProvider>
		);
		expect(() => held.get("copied")!("Bea")).toThrow(/not a node of this runtime's tree/);
	});
});

type IAnswer = "yes" | "no" | undefined;

function* asksOnRec(draft: IRoot) {
	const answered = yield* open(
		ask<IAnswer>(draft.Rec, {
			Path: "Confirm"
		})
	);
	draft.Result = String(answered);
}

function* answers(_owner: IEntity, id: IAskId<IAnswer>, value: IAnswer): IActionGenerator {
	yield* answer(id, value);
}

function* pending(draft: IRoot): ISelectorGenerator<readonly IAskEntry[]> {
	return yield* pendingAsks(draft);
}

const Asks = createEntityFeature<IRoot>("tests/dispatchTarget/Asks")(
	{},
	{
		pending
	}
);

describe("change 5: a dialog answers an ask by dispatching at its owner", () => {
	function mountAsks(runtime: ReturnType<typeof build>["runtime"], Body: (props: { entry: IAskEntry }) => ReactNode) {
		const View = Asks.provider(() => {
			const listed = Asks.use().pending();
			return listed.length === 0 ? <p>no dialog</p> : <Body key={listed[0]!.Id} entry={listed[0]!} />;
		});
		render(
			<TreflexProvider value={runtime}>
				<View
					state={{
						$Id: "root"
					}}
				/>
			</TreflexProvider>
		);
	}

	async function opened(runtime: ReturnType<typeof build>["runtime"]) {
		let asking!: Promise<void>;
		await act(async () => {
			asking = runtime.dispatch(asksOnRec, "root");
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		return {
			asking
		};
	}

	it("answers through useDispatch at entry.OwnerId", async () => {
		const { runtime } = build();
		mountAsks(runtime, (props) => {
			const dispatch = useDispatch();
			return (
				<button type="button" onClick={() => void dispatch(answers, props.entry.OwnerId, props.entry.Id as IAskId<IAnswer>, "yes")}>
					answer
				</button>
			);
		});
		const { asking } = await opened(runtime);
		await act(async () => {
			fireEvent.click(screen.getByText("answer"));
			await asking;
		});
		expect(runtime.state.Result).toBe("yes");
		expect(screen.getByText("no dialog")).toBeTruthy();
	});

	it("answers through the owner's view as the target, and refuses a dispatch above the owner", async () => {
		const { runtime } = build();
		const refused: unknown[] = [];
		mountAsks(runtime, (props) => {
			const dispatch = useDispatch();
			const owner = useEntity<IRec>(props.entry.OwnerId);
			const id = props.entry.Id as IAskId<IAnswer>;
			return (
				<>
					<button type="button" onClick={() => void dispatch(answers, "root", id, "no").catch((error: unknown) => refused.push(error))}>
						above
					</button>
					<button type="button" onClick={() => void dispatch(answers, owner!, id, "no")}>
						owner
					</button>
				</>
			);
		});
		const { asking } = await opened(runtime);
		await act(async () => {
			fireEvent.click(screen.getByText("above"));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(refused).toHaveLength(1);
		expect(refused[0]).toBeInstanceOf(AnswerOutsideOwnerError);
		await act(async () => {
			fireEvent.click(screen.getByText("owner"));
			await asking;
		});
		expect(runtime.state.Result).toBe("no");
	});
});
