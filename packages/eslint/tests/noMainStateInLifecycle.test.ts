import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import parser from "@typescript-eslint/parser";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { Linter } from "eslint";
import { afterAll, describe, expect, it } from "vitest";
import plugin from "../src/index";
import { noMainStateInLifecycle } from "../src/noMainStateInLifecycle";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
	languageOptions: {
		parserOptions: {
			ecmaFeatures: {
				jsx: true
			}
		}
	}
});

const SOLID = `
import { createComputed, createEffect, createRenderEffect, on, onCleanup, onMount, untrack } from "solid-js";
import { useComponentState, useDispatch } from "treflex-solid";
import Thread from "./Thread";
`;

const REACT = `
import React, { useCallback, useEffect, useLayoutEffect } from "react";
import Thread from "./Thread";
`;

function reported(where: string) {
	return [
		{
			messageId: "noMainStateInLifecycle" as const,
			data: {
				where,
				rule: "@rule-tester/no-main-state-in-lifecycle"
			}
		}
	];
}

function solid(body: string): string {
	return `${SOLID} function View(props: { id: string }) { const thread = Thread.use(); ${body} return null; }`;
}

const LIFECYCLE_FIXTURE = decodeURIComponent(new URL("./fixture/lifecycle", import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, "");

function imported(importLine: string, feature: string) {
	return {
		code: `import { onMount } from "solid-js"; ${importLine} function Body() { const widget = ${feature}.use(); onMount(() => void widget.load()); return null; }`,
		filename: `${LIFECYCLE_FIXTURE}/View.tsx`
	};
}

ruleTester.run("no-main-state-in-lifecycle", noMainStateInLifecycle, {
	valid: [
		solid(`return <button onClick={() => thread.load()}>Load</button>;`),
		solid(`onMount(() => { window.addEventListener("focus", () => thread.load()); });`),
		solid(`onMount(() => { const count = thread.count(); log(count); });`),
		solid(`createEffect(() => setTitle(thread.title()));`),
		solid(`createEffect(() => { if (thread.isOpen()) focus(); });`),
		solid(`const local = useComponentState(() => ({ Url: null })); onMount(() => local.dispatch(load));`),
		solid(`const load = () => thread.load(); return <button onClick={load}>Load</button>;`),
		solid(`const reload = () => thread.load(); return { reload };`),
		`${SOLID} import { createComponentFeature } from "treflex-solid"; const Grid = createComponentFeature("Widgets/Grid")({}, {}); function Body() { const grid = Grid.use(); onMount(() => grid.load()); return null; }`,
		`${SOLID} import * as T from "treflex-solid"; const Grid = T.createComponentFeature<IGrid>("Widgets/Grid")({}, {}); function Body() { const grid = Grid.use(); onMount(() => void grid.load()); return null; }`,
		`${SOLID} function View() { const value = React.use(context); onMount(() => value.load()); return null; }`,
		`import Thread from "./Thread"; function onMount(f: () => void) { f(); } function View() { const thread = Thread.use(); onMount(() => thread.load()); return null; }`,
		`import Thread from "./Thread"; function setTimeout(f: () => void) { f(); } function View() { const thread = Thread.use(); setTimeout(() => thread.load()); return null; }`,
		`${SOLID} function useThread() { const thread = Thread.use(); return () => thread.load(); }`,
		`${REACT} function View() { const thread = Thread.use(); const go = useCallback(() => thread.load(), []); return <button onClick={go} />; }`,
		`${REACT} function View() { const thread = Thread.use(); useEffect(() => { const ok = thread.isOpen(); setOpen(ok); }, []); return null; }`,
		`${SOLID} function View() { const dispatch = useDispatch(); return <button onClick={() => void dispatch(save, "App")} />; }`,
		`${SOLID} let thread = Thread.use(); thread = other; function View() { onMount(() => thread.load()); return null; }`,
		solid(`onMount(() => { const { state } = thread; log(state.Title); });`),
		solid(`return <button onClick={() => setTimeout(() => thread.load(), 100)}>Later</button>;`),
		solid(`onMount(() => { const onKey = () => thread.load(); document.addEventListener("keydown", onKey); });`),
		solid(`const count = untrack(() => thread.count()); return <div>{count}{thread.remaining()}</div>;`),
		solid(`return <Child onReady={() => { thread.load(); }} />;`),
		`${REACT} function View() { const thread = Thread.use(); const [pending, run] = useQueue(); useEffect(() => { run(() => { thread.load(); }); }, []); return null; }`,
		solid(`createEffect(on(thread.messages, () => scrollToBottom()));`),
		`${SOLID} const useThread = () => Thread.use(); function View() { const thread = useThread(); onMount(() => void thread.load()); return null; }`,
		imported(`import { GridFeature } from "./Grid";`, "GridFeature"),
		imported(`import { GridFeature as Grid } from "./Grid.js";`, "Grid"),
		imported(`import Panel from "./Panel";`, "Panel"),
		imported(`import Board from "./Board";`, "Board"),
		imported(`import { ListFeature } from "./widgets";`, "ListFeature"),
		`import { onMount } from "solid-js"; import { useDispatch } from "react-redux"; function View() { const dispatch = useDispatch(); onMount(() => { dispatch(load()); }); return null; }`,
		`import { useEffect } from "react"; import { useDispatch } from "@reduxjs/toolkit"; function View() { const dispatch = useDispatch(); useEffect(() => { dispatch(load()); }, []); return null; }`,
		`${SOLID} import { createMemo } from "solid-js"; function View(props: { id: string }) { const thread = Thread.use(); createMemo(on(() => props.id, (id) => thread.load(id))); return null; }`,
		solid(`onMount(() => { window.addEventListener("focus", thread.refresh); });`),
		solid(`return <button onClick={thread.open}>Open</button>;`),
		solid(`createMemo(on(() => props.id, thread.load)); log(thread.state); onMount(() => log(thread.state));`),
		solid(`return <For each={rows}>{(row) => <button onClick={() => thread.save(row)} />}</For>;`),
		solid(`return <For each={rows}>{(row) => { const save = () => void thread.save(row); return <button onClick={save} />; }}</For>;`),
		solid(`return <Show when={open()}>{() => thread.title()}</Show>;`),
		solid(`const count = createMemo(() => thread.count()); const same = createMemo(thread.count);`),
		solid(`createEffect(() => thread.load);`),
		`${REACT} import { useMemo } from "react"; function View() { const thread = Thread.use(); const save = useMemo(() => thread.save, []); const n = useMemo(() => thread.count(), []); return <button onClick={save}>{n}</button>; }`,
		`${REACT} function View(props: { rows: { id: string }[] }) { const thread = Thread.use(); return <ul>{props.rows.map((r) => thread.title(r))}</ul>; }`,
		`${REACT} function View(props: { ids: string[] }) { const thread = Thread.use(); return <button onClick={() => void Promise.all(props.ids.map((id) => thread.load(id)))} />; }`,
		`${REACT} function View(props: { ids: string[] }) { const thread = Thread.use(); useEffect(() => { void Promise.all(props.ids.map((id) => thread.load(id))); }, []); return null; }`,
		`${REACT} function View() { const thread = Thread.use(); useEffect(() => { const off = listen(); return off; }, []); const go = () => thread.save; return <button onClick={go} />; }`
	],
	invalid: [
		{
			code: `${REACT} import { useMemo } from "react"; function View() { const thread = Thread.use(); const n = useMemo(() => { void thread.load(); return 1; }, []); return n; }`,
			errors: reported("useMemo")
		},
		{
			code: `${REACT} function View(props: { rows: { id: string }[] }) { const thread = Thread.use(); return <ul>{props.rows.map((row) => { thread.prefetch(row.id); return <li />; })}</ul>; }`,
			errors: reported("the component's body")
		},
		{
			code: `${REACT} function View(props: { ids: string[] }) { const thread = Thread.use(); useEffect(() => { props.ids.map((id) => { void thread.load(id); }); }, []); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: solid(`return <For each={rows}>{(row) => { void thread.load(row.Id); return <li />; }}</For>;`),
			errors: reported("a render callback")
		},
		{
			code: solid(`return <Show when={open()}>{() => { thread.markSeen(); return <p />; }}</Show>;`),
			errors: reported("a render callback")
		},
		{
			code: solid(`const total = createMemo(() => { thread.load(); return 1; });`),
			errors: reported("createMemo")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useEffect(() => thread.save, []); return null; }`,
			errors: reported("useEffect's cleanup")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useEffect(() => { log(); return thread.stop; }, []); return null; }`,
			errors: reported("useEffect's cleanup")
		},
		{
			code: `${REACT} function View() { const { save } = Thread.use(); useEffect(() => save, []); return null; }`,
			errors: reported("useEffect's cleanup")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useLayoutEffect(() => { return thread.flush; }); return null; }`,
			errors: reported("useLayoutEffect's cleanup")
		},
		{
			code: solid(`onMount(thread.load);`),
			errors: reported("onMount")
		},
		{
			code: solid(`onCleanup(thread.save);`),
			errors: reported("onCleanup")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useEffect(() => { const id = setInterval(thread.poll, 5000); return () => clearInterval(id); }, []); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: solid(`createEffect(on(() => props.id, thread.load));`),
			errors: reported("createEffect")
		},
		{
			code: solid(`const save = thread.save; onCleanup(save);`),
			errors: reported("onCleanup")
		},
		{
			code: solid(`onMount(() => { fetchIt().then(thread.load); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`setInterval(thread.poll, 1000);`),
			errors: reported("the component's body")
		},
		{
			code: `${SOLID} function View() { const dispatch = useDispatch(); onMount(() => { fetchIt().then(dispatch); }); return null; }`,
			errors: reported("onMount")
		},
		{
			code: solid(`const poll = () => { void thread.poll(); setTimeout(poll, 1000); }; onMount(poll);`),
			errors: reported("onMount")
		},
		{
			code: `${SOLID} function View() { let thread = Thread.use(); onMount(() => thread.load()); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `import { startTransition, useEffect } from "react"; import Thread from "./Thread"; function View() { const thread = Thread.use(); useEffect(() => { startTransition(() => { thread.load(); }); }, []); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: solid(`createEffect(() => { thread.messages(); scrollToBottom(); });`),
			errors: reported("createEffect")
		},
		{
			code: `${SOLID} import { getOwner, runWithOwner } from "solid-js"; function View() { const owner = getOwner(); return <button onClick={() => runWithOwner(owner, () => void Thread.use().save())} />; }`,
			errors: reported("the component's body")
		},
		{
			...imported(`import Thread from "./Thread";`, "Thread"),
			errors: reported("onMount")
		},
		{
			...imported(`import { GridFeature } from "./widgets";`, "GridFeature"),
			errors: reported("onMount")
		},
		{
			...imported(`import { GridFeature } from "@/Grid";`, "GridFeature"),
			errors: reported("onMount")
		},
		{
			...imported(`import * as Grid from "./Grid";`, "Grid.GridFeature"),
			errors: reported("onMount")
		},
		{
			...imported(`import { Missing } from "./Grid";`, "Missing"),
			errors: reported("onMount")
		},
		{
			code: `${REACT} import { useTransition } from "react"; function View() { const thread = Thread.use(); const [pending, startTransition] = useTransition(); useEffect(() => { startTransition(() => { thread.load(); }); }, []); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); const [pending, start] = React.useTransition(); useEffect(() => { start(() => { thread.load(); }); }, []); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: solid(`onMount(() => thread.load());`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { thread.load(); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`createEffect(() => { void thread.markVisited(props.id); });`),
			errors: reported("createEffect")
		},
		{
			code: solid(`createComputed(() => thread.select(props.id));`),
			errors: reported("createComputed")
		},
		{
			code: solid(`createRenderEffect(() => { props.id && thread.select(props.id); });`),
			errors: reported("createRenderEffect")
		},
		{
			code: solid(`onCleanup(() => thread.save());`),
			errors: reported("onCleanup")
		},
		{
			code: solid(`createEffect(on(() => props.id, (id) => thread.load(id)));`),
			errors: reported("createEffect")
		},
		{
			code: solid(`onMount(async () => { const result = await thread.load(); log(result); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { const pending = thread.load().then(log); keep(pending); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { setTimeout(() => thread.load(), 100); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { window.setTimeout(() => { thread.load(); }); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { queueMicrotask(() => thread.load()); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { fetchIt().then(() => thread.load()); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`createEffect(() => { const id = props.id; untrack(() => thread.load(id)); });`),
			errors: reported("createEffect")
		},
		{
			code: solid(`onMount(() => { (async () => { await thread.load(); })(); });`),
			errors: reported("onMount")
		},
		{
			code: solid(`createEffect(() => { props.ids.forEach((id) => thread.load(id)); });`),
			errors: reported("createEffect")
		},
		{
			code: solid(`setTimeout(() => thread.tick(), 1000);`),
			errors: reported("the component's body")
		},
		{
			code: solid(`thread.load();`),
			errors: reported("the component's body")
		},
		{
			code: solid(`const load = () => thread.load(); onMount(load);`),
			errors: reported("onMount")
		},
		{
			code: solid(`function refresh() { thread.load(); } createEffect(() => refresh());`),
			errors: reported("createEffect")
		},
		{
			code: solid(`const refresh = () => { thread.load(); }; refresh(); return <button onClick={refresh} />;`),
			errors: reported("the component's body")
		},
		{
			code: solid(`const other = thread; const { load, save: store } = other; onMount(() => { load(); store(); });`),
			errors: [
				...reported("onMount"),
				...reported("onMount")
			]
		},
		{
			code: solid(`const save = thread.save; onCleanup(() => save());`),
			errors: reported("onCleanup")
		},
		{
			code: solid(`onMount(() => thread["load"]());`),
			errors: reported("onMount")
		},
		{
			code: solid(`onMount(() => { thread.load(), thread.save(); });`),
			errors: [
				...reported("onMount"),
				...reported("onMount")
			]
		},
		{
			code: solid(`onMount(() => { ready ? thread.load() : thread.save(); });`),
			errors: [
				...reported("onMount"),
				...reported("onMount")
			]
		},
		{
			code: solid(`onMount(() => { thread?.load(); (thread.save() as unknown); });`),
			errors: [
				...reported("onMount"),
				...reported("onMount")
			]
		},
		{
			code: `${SOLID} function View() { onMount(() => { Thread.use().load(); }); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `${SOLID} function View() { const dispatch = useDispatch(); onMount(() => { void dispatch(save, "App"); }); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `${SOLID} function View() { const dispatch = useDispatch(); void dispatch(save, "App"); return null; }`,
			errors: reported("the component's body")
		},
		{
			code: `${SOLID} import Grid from "./Grid"; function Body() { const grid = Grid.use(); onMount(() => grid.load()); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `import * as Solid from "solid-js"; import Thread from "./Thread"; function View() { const thread = Thread.use(); Solid.onMount(() => thread.load()); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `import { onMount as mounted } from "solid-js"; import Thread from "./Thread"; function View() { const thread = Thread.use(); mounted(() => thread.load()); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `import Thread from "./Thread"; function View() { const thread = Thread.use(); onMount(() => thread.load()); return null; }`,
			errors: reported("onMount")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useEffect(() => { void thread.load(); }, []); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); React.useLayoutEffect(() => { thread.load(); }, []); return null; }`,
			errors: reported("useLayoutEffect")
		},
		{
			code: `import * as R from "react"; import Thread from "./Thread"; function View() { const thread = Thread.use(); R.useEffect(() => { thread.load(); }); return null; }`,
			errors: reported("useEffect")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useEffect(() => () => thread.save(), []); return null; }`,
			errors: reported("useEffect's cleanup")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); useLayoutEffect(() => { const off = listen(); return () => { off(); thread.save(); }; }, []); return null; }`,
			errors: reported("useLayoutEffect's cleanup")
		},
		{
			code: `${REACT} function View() { const thread = Thread.use(); const go = useCallback(() => { thread.load(); }, []); useEffect(() => { go(); }, [go]); return <button onClick={go} />; }`,
			errors: reported("useEffect")
		},
		{
			code: `${SOLID} function View() { onMount(() => Thread.use().load()); return null; }`,
			errors: reported("onMount")
		}
	]
});

const SOLID2 = `
import { createEffect, createReaction, createRenderEffect, createTrackedEffect, onFlush, onSettled } from "solid-js";
import Thread from "./Thread";
`;

function solid2(body: string): string {
	return `${SOLID2} function View(props: { id: string }) { const thread = Thread.use(); ${body} return null; }`;
}

describe("Solid 2's lifecycle", () =>
	ruleTester.run("no-main-state-in-lifecycle", noMainStateInLifecycle, {
		valid: [
			solid2(`createEffect(() => thread.messages(), () => scrollToBottom());`),
			solid2(`createEffect(() => [thread.messages(), thread.draft()], () => scrollToBottom());`),
			solid2(`createEffect(thread.messages, () => scrollToBottom());`),
			solid2(`createEffect(() => thread.id(), (id) => setTitle(id), { defer: true });`),
			solid2(`return <button onClick={() => onSettled(() => void thread.save())}>Save</button>;`),
			solid2(`return <button onClick={() => onFlush(() => void thread.save())}>Save</button>;`),
			solid2(`const track = createReaction(() => scrollToBottom()); track(() => void thread.load());`)
		],
		invalid: [
			{
				code: solid2(`createEffect(() => { void thread.load(); return props.id; }, () => {});`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => thread.id(), (id) => { void thread.load(id); });`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => props.id, thread.load);`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => thread.id(), { effect: (id) => { void thread.load(id); }, error: () => {} });`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => thread.id(), { effect() {}, error() { void thread.report(); } });`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => thread.id(), () => () => void thread.stop());`),
				errors: reported("createEffect's cleanup")
			},
			{
				code: solid2(`createEffect(() => thread.id(), () => thread.stop);`),
				errors: reported("createEffect's cleanup")
			},
			{
				code: solid2(`createEffect(() => thread.id(), { effect: () => () => void thread.stop(), error: () => {} });`),
				errors: reported("createEffect's cleanup")
			},
			{
				code: solid2(`createRenderEffect(() => thread.id(), (id) => { void thread.load(id); });`),
				errors: reported("createRenderEffect")
			},
			{
				code: solid2(`createTrackedEffect(() => { void thread.load(); });`),
				errors: reported("createTrackedEffect")
			},
			{
				code: solid2(`createTrackedEffect(() => () => void thread.stop());`),
				errors: reported("createTrackedEffect's cleanup")
			},
			{
				code: solid2(`const track = createReaction(() => { void thread.load(); });`),
				errors: reported("createReaction")
			},
			{
				code: solid2(`const track = createReaction({ effect: () => { void thread.load(); }, error: () => {} });`),
				errors: reported("createReaction")
			},
			{
				code: solid2(`onSettled(() => void thread.load());`),
				errors: reported("onSettled")
			},
			{
				code: solid2(`onSettled(() => () => void thread.stop());`),
				errors: reported("onSettled's cleanup")
			},
			{
				code: solid2(`onSettled(() => thread.stop);`),
				errors: reported("onSettled's cleanup")
			},
			{
				code: solid2(`createEffect(() => thread.id(), () => { onSettled(() => void thread.load()); });`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`onFlush(() => void thread.load());`),
				errors: reported("the component's body")
			},
			{
				code: solid2(`createEffect(() => thread.load());`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => thread.load(), 0);`),
				errors: reported("createEffect")
			},
			{
				code: solid2(`createEffect(() => thread.load(), undefined);`),
				errors: reported("createEffect")
			}
		]
	}));

describe("an imported module that changes between lints in one process", () => {
	const COMPONENT = `import { createComponentFeature } from "treflex-solid"; export const GridFeature = createComponentFeature("Widgets/Grid")({});`;
	const ENTITY = `import { createEntityFeature } from "treflex-solid"; export const GridFeature = createEntityFeature("Widgets/Grid")({}, {});`;
	const VIEW = `import { onMount } from "solid-js"; import { GridFeature } from "./Grid"; function Body() { const grid = GridFeature.use(); onMount(() => void grid.load()); return null; }`;

	it("reads the module as it stands at each lint", () => {
		const dir = mkdtempSync(join(tmpdir(), "treflex-lifecycle-"));
		let tick = 1_800_000_000_000;
		const write = (name: string, text: string) => {
			const path = join(dir, name);
			writeFileSync(path, text);
			tick += 10_000;
			utimesSync(path, new Date(tick), new Date(tick));
		};
		const reports = () =>
			new Linter({
				cwd: dir
			}).verify(
				VIEW,
				[
					{
						files: [
							"**/*.tsx"
						],
						languageOptions: {
							parser
						},
						plugins: {
							treflex: plugin
						},
						rules: {
							"treflex/no-main-state-in-lifecycle": "error"
						}
					}
				] as never,
				join(dir, "View.tsx")
			).length;
		try {
			expect(reports()).toBe(1);
			write("Grid.ts", COMPONENT);
			expect(reports()).toBe(0);
			write("Grid.ts", ENTITY);
			expect(reports()).toBe(1);
			rmSync(join(dir, "Grid.ts"));
			write("Grid.tsx", COMPONENT);
			expect(reports()).toBe(0);
			write("Grid.ts", ENTITY);
			expect(reports()).toBe(1);
			rmSync(join(dir, "Grid.ts"));
			rmSync(join(dir, "Grid.tsx"));
			expect(reports()).toBe(1);
		} finally {
			rmSync(dir, {
				recursive: true,
				force: true
			});
		}
	});
});

describe("the plugin", () => {
	it("registers the rule", () => {
		expect(plugin.rules["no-main-state-in-lifecycle"]).toBe(noMainStateInLifecycle);
	});

	it("takes the standard disable comment with a reason for one line", () => {
		const linter = new Linter();
		const code = `${SOLID}
function View() {
	const thread = Thread.use();
	// eslint-disable-next-line treflex/no-main-state-in-lifecycle -- marks the thread visited when its completion is on screen; leading and checks state
	createEffect(() => { void thread.markVisited(); });
	onMount(() => thread.load());
	return null;
}`;
		const messages = linter.verify(
			code,
			[
				{
					files: [
						"**/*.tsx"
					],
					languageOptions: {
						parser
					},
					plugins: {
						treflex: plugin
					},
					rules: {
						"treflex/no-main-state-in-lifecycle": "error"
					}
				}
			] as never,
			"view.tsx"
		);
		expect(
			messages.map((message) => [
				message.ruleId,
				message.line
			])
		).toEqual([
			[
				"treflex/no-main-state-in-lifecycle",
				10
			]
		]);
	});

	it("takes views.md's opt-in sample in onSettled, with no unused directive", () => {
		const linter = new Linter();
		const code = `${SOLID2}
function View() {
	const thread = Thread.use();
	// eslint-disable-next-line treflex/no-main-state-in-lifecycle -- the completion on screen is the visit; markVisited checks state and is leading
	onSettled(() => void thread.markVisited());
	return null;
}`;
		const messages = linter.verify(
			code,
			[
				{
					files: [
						"**/*.tsx"
					],
					languageOptions: {
						parser
					},
					linterOptions: {
						reportUnusedDisableDirectives: "error"
					},
					plugins: {
						treflex: plugin
					},
					rules: {
						"treflex/no-main-state-in-lifecycle": "error"
					}
				}
			] as never,
			"view.tsx"
		);
		expect(messages).toEqual([]);
	});
});
