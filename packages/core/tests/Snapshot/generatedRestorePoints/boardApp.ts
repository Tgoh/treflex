import type { IRuntime } from "../../../src/Runtime/createRuntime";
import type { IRestoreResult } from "../../../src/Snapshot/loadSnapshot";
import type { IEffectStub } from "../../../src/Testing/createTestRuntime";
import type { IAction, IActionGenerator } from "../../../src/Types/IAction";
import type { IEntity } from "../../../src/Types/IEntity";
import { defineEffect } from "../../../src/Effects/defineEffect";
import { entity } from "../../../src/Effects/entity";
import { parallel } from "../../../src/Effects/parallel";
import { latest, leading } from "../../../src/Runtime/arrivalPolicy";
import { named } from "../../../src/Runtime/named";
import { open } from "../../../src/Runtime/open";

export interface IJob {
	Key: string;
	Act: string;
	Args: unknown[];
	Done?: string[];
}

export interface IItem extends IEntity {
	Key: string;
	Title: string;
	Note: string;
	Hits: number;
	Jobs: IJob[];
}

export interface IList extends IEntity {
	Key: string;
	Name: string;
	Items: IItem[];
	Jobs: IJob[];
}

export interface IBoard extends IEntity {
	Lists: IList[];
	Limbo: IItem[];
	Jobs: IJob[];
	Saved: string[];
	Log: string[];
	Selected: string | null;
}

export const seed: IBoard = {
	$Id: "board",
	Lists: [
		{
			$Id: "list-a",
			Key: "A",
			Name: "a",
			Items: [],
			Jobs: []
		},
		{
			$Id: "list-b",
			Key: "B",
			Name: "b",
			Items: [],
			Jobs: []
		},
		{
			$Id: "list-c",
			Key: "C",
			Name: "c",
			Items: [],
			Jobs: []
		}
	],
	Limbo: [],
	Jobs: [],
	Saved: [],
	Log: [],
	Selected: null
};

export const save = defineEffect<
	{
		Type: "Board/Save";
		Key: string;
	},
	void
>("Board/Save");

export const transfer = defineEffect<
	{
		Type: "Board/Transfer";
		Key: string;
	},
	void
>("Board/Transfer");

export const fetchText = defineEffect<
	{
		Type: "Board/Fetch";
		Key: string;
	},
	string
>("Board/Fetch");

export const tick = defineEffect<
	{
		Type: "Board/Tick";
	},
	number
>("Board/Tick");

export function counterStubs(): Record<string, IEffectStub> {
	let n = 0;
	return {
		[tick.Type]: () => ++n
	};
}

function upsert(jobs: IJob[], job: IJob): void {
	if (!jobs.some((j) => j.Key === job.Key)) {
		jobs.push(job);
	}
}

function clear(jobs: IJob[], key: string): void {
	const at = jobs.findIndex((j) => j.Key === key);
	if (at !== -1) {
		jobs.splice(at, 1);
	}
}

function locate(
	board: IBoard,
	key: string
):
	| {
			items: IItem[];
			index: number;
			limbo: boolean;
	  }
	| undefined {
	for (const list of board.Lists) {
		const index = list.Items.findIndex((i) => i.Key === key);
		if (index !== -1) {
			return {
				items: list.Items,
				index,
				limbo: false
			};
		}
	}
	const index = board.Limbo.findIndex((i) => i.Key === key);
	return index === -1
		? undefined
		: {
				items: board.Limbo,
				index,
				limbo: true
			};
}

const listOn = (board: IBoard, key: string): IList => board.Lists.find((l) => l.Key === key)!;

function* addItem(board: IBoard, token: string, listKey: string, title: string): IActionGenerator<boolean> {
	upsert(board.Jobs, {
		Key: token,
		Act: "Board/AddItem",
		Args: [
			token,
			listKey,
			title
		]
	});
	try {
		if (!locate(board, token)) {
			const item = yield* entity<IItem>({
				Key: token,
				Title: title,
				Note: "",
				Hits: 0,
				Jobs: []
			});
			listOn(board, listKey).Items.push(item);
		}
		yield* save({
			Key: token
		});
		if (!board.Saved.includes(token)) {
			board.Saved.push(token);
		}
	} catch (error) {
		clear(board.Jobs, token);
		throw error;
	}
	clear(board.Jobs, token);
	return true;
}
named(addItem, "Board/AddItem");

function* moveNow(board: IBoard, token: string, itemKey: string, listKey: string): IActionGenerator<boolean> {
	const at = locate(board, itemKey);
	if (at && !at.limbo) {
		const [item] = at.items.splice(at.index, 1);
		listOn(board, listKey).Items.push(item!);
	}
	board.Log.push(`moved ${itemKey} by ${token}`);
	return true;
}
named(moveNow, "Board/MoveNow");

function* moveWait(board: IBoard, token: string, itemKey: string, listKey: string): IActionGenerator<boolean> {
	upsert(board.Jobs, {
		Key: token,
		Act: "Board/MoveWait",
		Args: [
			token,
			itemKey,
			listKey
		]
	});
	try {
		const at = locate(board, itemKey);
		if (at && !at.limbo) {
			const [item] = at.items.splice(at.index, 1);
			board.Limbo.push(item!);
		}
		yield* transfer({
			Key: token
		});
		const index = board.Limbo.findIndex((i) => i.Key === itemKey);
		if (index !== -1) {
			const [item] = board.Limbo.splice(index, 1);
			listOn(board, listKey).Items.push(item!);
		}
	} catch (error) {
		clear(board.Jobs, token);
		throw error;
	}
	clear(board.Jobs, token);
	return true;
}
named(moveWait, "Board/MoveWait");

function* removeItem(board: IBoard, token: string, itemKey: string): IActionGenerator<boolean> {
	const at = locate(board, itemKey);
	if (at) {
		const [item] = at.items.splice(at.index, 1);
		if (board.Selected === item!.$Id) {
			board.Selected = null;
		}
	}
	board.Log.push(`removed ${itemKey} by ${token}`);
	return true;
}
named(removeItem, "Board/RemoveItem");

function* selectItem(board: IBoard, token: string, itemKey: string): IActionGenerator<boolean> {
	upsert(board.Jobs, {
		Key: token,
		Act: "Board/SelectItem",
		Args: [
			token,
			itemKey
		]
	});
	const chosen = locate(board, itemKey);
	const id = chosen ? chosen.items[chosen.index]!.$Id : null;
	try {
		yield* save({
			Key: token
		});
	} catch (error) {
		clear(board.Jobs, token);
		throw error;
	}
	board.Selected = id;
	clear(board.Jobs, token);
	return true;
}
named(selectItem, "Board/SelectItem");

function* saveBranch(board: IBoard, token: string, part: string, key: string): IActionGenerator<void> {
	if (board.Jobs.find((j) => j.Key === token)!.Done!.includes(part)) {
		return;
	}
	yield* save({
		Key: `${token}/${part}`
	});
	board.Jobs.find((j) => j.Key === token)!.Done!.push(part);
	if (!board.Saved.includes(key)) {
		board.Saved.push(key);
	}
}

function* saveTwo(board: IBoard, token: string, a: string, b: string): IActionGenerator<boolean> {
	upsert(board.Jobs, {
		Key: token,
		Act: "Board/SaveTwo",
		Args: [
			token,
			a,
			b
		],
		Done: []
	});
	try {
		yield* parallel(saveBranch(board, token, "a", a), saveBranch(board, token, "b", b));
	} catch (error) {
		clear(board.Jobs, token);
		throw error;
	}
	clear(board.Jobs, token);
	return true;
}
named(saveTwo, "Board/SaveTwo");

function* openNote(board: IBoard, token: string, text: string) {
	upsert(board.Jobs, {
		Key: token,
		Act: "Board/OpenNote",
		Args: [
			token,
			text
		]
	});
	let got: string;
	try {
		got = yield* open(
			fetchText({
				Key: token
			})
		);
	} catch (error) {
		clear(board.Jobs, token);
		throw error;
	}
	board.Log.push(`${text}:${got}`);
	clear(board.Jobs, token);
	return true;
}
named(openNote, "Board/OpenNote");

function* renameList(list: IList, token: string, name: string) {
	upsert(list.Jobs, {
		Key: token,
		Act: "Board/RenameList",
		Args: [
			token,
			name
		]
	});
	let got: string;
	try {
		got = yield* open(
			fetchText({
				Key: token
			})
		);
	} catch (error) {
		clear(list.Jobs, token);
		throw error;
	}
	list.Name = `${name}:${got}`;
	clear(list.Jobs, token);
	return true;
}
named(renameList, "Board/RenameList");

function* renameItem(item: IItem, token: string, title: string): IActionGenerator<boolean> {
	const slot = item.Jobs.find((j) => j.Key === "rename");
	if (slot) {
		slot.Args = [
			token,
			title
		];
	} else {
		item.Jobs.push({
			Key: "rename",
			Act: "Board/RenameItem",
			Args: [
				token,
				title
			]
		});
	}
	const mine = () => item.Jobs.find((j) => j.Key === "rename")?.Args[0] === token;
	try {
		yield* save({
			Key: token
		});
	} catch (error) {
		if (mine()) {
			clear(item.Jobs, "rename");
		}
		throw error;
	}
	item.Title = title;
	if (mine()) {
		clear(item.Jobs, "rename");
	}
	return true;
}
named(renameItem, "Board/RenameItem");
latest(renameItem);

function* touchItem(item: IItem, token: string): IActionGenerator<boolean> {
	upsert(item.Jobs, {
		Key: token,
		Act: "Board/TouchItem",
		Args: [
			token
		]
	});
	try {
		yield* save({
			Key: token
		});
	} catch (error) {
		clear(item.Jobs, token);
		throw error;
	}
	item.Note = `touched ${token}`;
	clear(item.Jobs, token);
	return true;
}
named(touchItem, "Board/TouchItem");
leading(touchItem);

function* catchSave(item: IItem, token: string): IActionGenerator<boolean> {
	upsert(item.Jobs, {
		Key: token,
		Act: "Board/CatchSave",
		Args: [
			token
		]
	});
	try {
		yield* save({
			Key: token
		});
		item.Note = `ok ${token}`;
	} catch (error) {
		item.Note = `err ${(error as Error).message}`;
	}
	clear(item.Jobs, token);
	return true;
}
named(catchSave, "Board/CatchSave");

function* countHits(item: IItem, token: string): IActionGenerator<boolean> {
	upsert(item.Jobs, {
		Key: token,
		Act: "Board/CountHits",
		Args: [
			token
		]
	});
	try {
		yield* save({
			Key: token
		});
	} catch (error) {
		clear(item.Jobs, token);
		throw error;
	}
	item.Hits = yield* tick();
	clear(item.Jobs, token);
	return true;
}
named(countHits, "Board/CountHits");

export const ACTIONS: Record<string, IAction<any, any[], boolean>> = {
	"Board/AddItem": addItem,
	"Board/MoveNow": moveNow,
	"Board/MoveWait": moveWait,
	"Board/RemoveItem": removeItem,
	"Board/SelectItem": selectItem,
	"Board/SaveTwo": saveTwo,
	"Board/OpenNote": openNote,
	"Board/RenameList": renameList,
	"Board/RenameItem": renameItem,
	"Board/TouchItem": touchItem,
	"Board/CatchSave": catchSave,
	"Board/CountHits": countHits
};

export const ALL_ACTIONS = Object.values(ACTIONS);

export function allItems(board: IBoard): IItem[] {
	return [
		...board.Lists.flatMap((l) => l.Items),
		...board.Limbo
	];
}

const plain = <V>(value: V): V => JSON.parse(JSON.stringify(value)) as V;

/** Dispatches again every action the restore dropped, from the job each keeps in state while it runs. */
export function faithfulRepair(runtime: IRuntime<IBoard>, _result: IRestoreResult): void {
	const board = runtime.state;
	const work: {
		job: IJob;
		on: string;
	}[] = [
		...plain(board.Jobs).map((job) => ({
			job,
			on: board.$Id
		})),
		...board.Lists.flatMap((list) =>
			plain(list.Jobs).map((job) => ({
				job,
				on: list.$Id
			}))
		),
		...allItems(board).flatMap((item) =>
			plain(item.Jobs).map((job) => ({
				job,
				on: item.$Id
			}))
		)
	];
	for (const { job, on } of work) {
		void runtime.dispatch(ACTIONS[job.Act]!, on, ...job.Args).catch(() => {});
	}
}
