import type { JSX } from "@solidjs/web";
import type { IActionGenerator, IEntity, ILocation, IRecord } from "treflex";
import { createContext, For, onCleanup, Show, useContext } from "solid-js";
import { createRuntime, entity, transient } from "treflex";
import { describe, expect, it } from "vitest";
import { createEntityFeature } from "../src/Context/createEntityFeature";
import { TreflexProvider, useDispatch, useLocate } from "../src/Context/TreflexContext";
import { mount } from "./mount";

function* nodeAt(draft: any, at: ILocation): IActionGenerator<any> {
	let node = at.TransientName === undefined ? draft : yield* transient(draft, at.TransientName, {});
	for (const key of at.Path) {
		node = node?.[key];
	}
	return node !== null && typeof node === "object" ? node : undefined;
}

function* setFieldAction(draft: object, at: ILocation, field: string | number, value: unknown): IActionGenerator {
	const node = yield* nodeAt(draft, at);
	if (node) {
		node[field] = value;
	}
}

function* addRowAction(draft: object, at: ILocation, field: string | number, row: object): IActionGenerator {
	const node = yield* nodeAt(draft, at);
	if (!node) {
		return;
	}
	const added = yield* entity(row);
	if (Array.isArray(node[field])) {
		node[field].push(added);
	} else {
		node[field] = [
			added
		];
	}
}

function* removeRowAction(draft: object, at: ILocation, field: string | number, index: number): IActionGenerator {
	(yield* nodeAt(draft, at))?.[field]?.splice(index, 1);
}

type IFormBindings = {
	state: any;
};

const FormContext = createContext<IFormBindings>({
	state: undefined
});

function FormProvider(props: { state: unknown; children: JSX.Element }) {
	const bindings: IFormBindings = {
		get state() {
			return props.state;
		}
	};
	return <FormContext value={bindings}>{props.children}</FormContext>;
}

function useFormField() {
	const form = useContext(FormContext);
	const dispatch = useDispatch();
	const locate = useLocate();
	const write = (
		action: (draft: object, at: ILocation, field: string | number, arg: any) => IActionGenerator,
		field: string | number,
		arg: unknown
	) => {
		const at = locate(form.state);
		if (!at) {
			return;
		}
		return dispatch(action, at.EntityId, at, field, arg);
	};
	return {
		value: <T,>(field: string | number): T => form.state?.[field],
		set: (field: string | number, value: unknown) => write(setFieldAction, field, value),
		addRow: (field: string | number, row: object) => write(addRowAction, field, row),
		removeRow: (field: string | number, index: number) => write(removeRowAction, field, index)
	};
}

type IField = {
	value: () => unknown;
	set: (value: unknown) => Promise<void> | undefined;
};

// Stands in for a DOM input: the test calls what its onInput and onBlur would.
const fields = new Map<string, IField>();
const blurs: unknown[] = [];
function TextField(props: { field: string; name?: string; blurValue?: string }) {
	const form = useFormField();
	fields.set(props.name ?? props.field, {
		value: () => form.value(props.field),
		set: (value) => form.set(props.field, value)
	});
	if (props.blurValue !== undefined) {
		onCleanup(() => {
			blurs.push(form.set(props.field, props.blurValue));
		});
	}
	return null;
}

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
}

interface IDialog extends IEntity {
	Contact: IContact;
}

interface IRoot extends IEntity {
	Rec: IRec;
	Dialog: IDialog | null;
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
			},
			{
				$Id: "p2",
				Number: "2"
			}
		])
	},
	Dialog: null
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function* openDialog(draft: IRoot): IActionGenerator {
	draft.Dialog = yield* entity({
		Contact: contact()
	});
}

function* closeDialog(draft: IRoot): IActionGenerator {
	draft.Dialog = null;
}

const Screen = createEntityFeature<IRoot>("tests/formBinding/Screen")({
	openDialog,
	closeDialog
});

function world(body: (state: IRoot) => JSX.Element) {
	fields.clear();
	blurs.length = 0;
	const runtime = createRuntime<IRoot>(seed());
	const records: IRecord[] = [];
	runtime.on("record", (record) => records.push(record));
	const diags: string[] = [];
	runtime.on("diag", (event) => diags.push(event.code));
	let screen!: ReturnType<typeof Screen.use>;
	const View = Screen.provider((props: { state: IRoot }) => {
		screen = Screen.use();
		return body(props.state);
	});
	const { dispose } = mount(() => (
		<TreflexProvider value={runtime}>
			<View state={runtime.state} />
		</TreflexProvider>
	));
	return {
		runtime,
		records,
		diags,
		screen: () => screen,
		field: (name: string) => fields.get(name)!,
		changes: () =>
			records.flatMap((r) =>
				r.Kind === "step"
					? r.Changes.map((c) => ({
							ActionId: r.ActionId,
							Path: c.Path
						}))
					: []
			),
		starts: () => records.filter((r) => r.Kind === "action:start" && r.Label !== "openDialog" && r.Label !== "closeDialog"),
		dispose: () => {
			dispose();
			runtime.dispose();
		}
	};
}

describe("a form binding over locate", () => {
	it("writes a nested field through one action on the entity, with no setter threaded, and records the full path", async () => {
		const w = world((state) => (
			<FormProvider state={state.Rec.Contact}>
				<TextField field="Name" />
				<FormProvider state={state.Rec.Contact.Address}>
					<TextField field="Street" />
				</FormProvider>
			</FormProvider>
		));

		await w.field("Name").set("Bea");
		await w.field("Street").set("2 High");

		expect(w.runtime.state.Rec.Contact.Name).toBe("Bea");
		expect(w.runtime.state.Rec.Contact.Address.Street).toBe("2 High");
		expect(w.field("Name").value()).toBe("Bea");
		expect(
			w.starts().map(
				(r) =>
					r.Kind === "action:start" && [
						r.Label,
						r.EntityId,
						r.Path
					]
			)
		).toEqual([
			[
				"setFieldAction",
				"rec",
				[
					"root",
					"rec"
				]
			],
			[
				"setFieldAction",
				"rec",
				[
					"root",
					"rec"
				]
			]
		]);
		expect(w.changes().map((c) => c.Path)).toEqual([
			[
				"Contact",
				"Name"
			],
			[
				"Contact",
				"Address",
				"Street"
			]
		]);
		expect(w.diags).toEqual([]);
		w.dispose();
	});

	it("addresses each entity row by its own $Id, through adds and removes", async () => {
		let form!: ReturnType<typeof useFormField>;
		const Rows = () => {
			form = useFormField();
			return null;
		};
		const w = world((state) => (
			<FormProvider state={state.Rec.Contact}>
				<Rows />
				<For each={state.Rec.Contact.Phones}>
					{(phone) => (
						<FormProvider state={phone}>
							<TextField field="Number" name={`phone-${phone.Number}`} />
						</FormProvider>
					)}
				</For>
			</FormProvider>
		));

		await form.removeRow("Phones", 0);
		await w.field("phone-2").set("two");
		await form.addRow("Phones", {
			Number: "3"
		});
		await settle();
		await w.field("phone-3").set("three");

		const phones = w.runtime.state.Rec.Contact.Phones;
		expect(phones.map((p) => p.Number)).toEqual([
			"two",
			"three"
		]);
		expect(
			w.starts().map((r) =>
				r.Kind === "action:start"
					? [
							r.Label,
							r.EntityId
						]
					: []
			)
		).toEqual([
			[
				"removeRowAction",
				"rec"
			],
			[
				"setFieldAction",
				"p2"
			],
			[
				"addRowAction",
				"rec"
			],
			[
				"setFieldAction",
				phones[1]!.$Id
			]
		]);
		w.dispose();
	});

	it("writes a node in a transient through transient() on the transient's owner", async () => {
		const NAME = "Tests/FormBinding/Draft";
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
		const Rec = createEntityFeature<IRec>("tests/formBinding/Draft")(
			{
				openDraft
			},
			{
				draftOf
			}
		);
		const Body = Rec.provider(() => {
			const rec = Rec.use();
			return (
				<FormProvider state={rec.draftOf()}>
					<TextField field="Name" name="draft" />
				</FormProvider>
			);
		});
		const w = world((state) => <Body state={state.Rec} />);
		await w.runtime.dispatch(openDraft, "rec");

		await w.field("draft").set("typed");

		expect(w.field("draft").value()).toBe("typed");
		expect(w.changes().at(-1)!.Path.join(".")).toBe(`TransientState.rec.${NAME}.Name`);
		expect(w.diags).toEqual([]);
		w.dispose();
	});

	it("stays silent for a write that fires as its form unmounts, whatever the state prop reads then", async () => {
		const w = world((state) => (
			<>
				<Show when={state.Dialog}>
					<FormProvider state={state.Dialog?.Contact}>
						<TextField field="Name" name="by-prop" blurValue="lost" />
					</FormProvider>
				</Show>
				<Show when={state.Dialog} keyed>
					{(dialog) => (
						<FormProvider state={dialog.Contact}>
							<TextField field="Name" name="by-node" blurValue="lost" />
						</FormProvider>
					)}
				</Show>
			</>
		));
		await w.screen().openDialog();
		await settle();
		await w.field("by-prop").set("typed");
		expect(w.runtime.state.Dialog!.Contact.Name).toBe("typed");
		const held = w.field("by-node");

		await w.screen().closeDialog();
		await settle();
		expect(blurs).toEqual([
			undefined,
			undefined
		]);
		expect(held.set("after")).toBeUndefined();

		expect(w.runtime.state.Dialog).toBeNull();
		expect(w.records.filter((r) => r.Kind === "action:end" && r.Status === "errored")).toEqual([]);
		expect(w.diags).toEqual([]);
		w.dispose();
	});

	it("throws for a form handed a copy, rather than dropping its writes", () => {
		const w = world((state) => (
			<FormProvider
				state={{
					...state.Rec.Contact
				}}
			>
				<TextField field="Name" />
			</FormProvider>
		));

		expect(() => w.field("Name").set("Bea")).toThrow(/not a node of this runtime's tree/);
		expect(w.runtime.state.Rec.Contact.Name).toBe("Ada");
		w.dispose();
	});

	it("leaves the provider's refusal loud: a feature mounted on a node that isn't the indexed one rejects and diags", async () => {
		function* rename(draft: IRec, name: string): IActionGenerator {
			draft.Contact.Name = name;
		}
		const Rec = createEntityFeature<IRec>("tests/formBinding/Rec")({
			rename
		});
		let rec!: ReturnType<typeof Rec.use>;
		const Body = Rec.provider(() => {
			rec = Rec.use();
			return null;
		});
		const other = createRuntime<IRoot>(seed());
		const w = world(() => <Body state={other.state.Rec} />);

		await expect(rec.rename("Bea")).rejects.toThrow(/not a node of this runtime's tree/);
		expect(w.diags).toEqual([
			"dispatch/node-mismatch"
		]);
		other.dispose();
		w.dispose();
	});
});
