import type { IRuntimeInternal } from "../Runtime/internals";
import type { ISnapshot } from "../Snapshot/ISnapshot";
import type { IInFlightListing, IRestoreDrop, IRestoreResumed } from "../Snapshot/loadSnapshot";
import type { IReleaseWindow } from "./IPrefix";
import type { IResumeDrop, IResumed } from "./resume";
import { isIdempotent } from "../Runtime/effectDeclarations";
import { actionNamed, displayName } from "../Runtime/named";
import { historiesOf } from "../Snapshot/loadSnapshot";
import { DEV } from "../Utility/devMode";
import { resumeInFlight } from "./resume";
import { UnreleasedResumeError } from "./unreleasedResumeError";

/** What a restore's resume stage gives the restore. */
export interface IResumeStage {
	readonly resumed: IRestoreResumed[];
	readonly dropped: IRestoreDrop[];
	/** Sends the held waits and lets the resumed lines go, and neither the public dispatch nor a `start` is refused any more. Once. */
	release(): void;
}

function windowOver(resumed: readonly IResumed[]): IReleaseWindow {
	const sameFunction = (via: string, action: Function, key: string): Error | null => {
		const same = resumed.find((entry) => entry.entityId === key && actionNamed(entry.name) === action);
		if (same === undefined) {
			return null;
		}
		return new UnreleasedResumeError(
			`[treflex] ${via}: "${same.name}" on "${key}" is refused until the restore releases what it resumed: the restore ` +
				`resumed "${same.name}" there, and a second run would do its work again. A repair acts on result.dropped, never on the ` +
				"tree alone.",
			same
		);
	};
	return {
		refuse(action, key, holderId) {
			const holder = holderId === null ? undefined : resumed.find((entry) => entry.holderId === holderId);
			if (holder !== undefined) {
				return new UnreleasedResumeError(
					`[treflex] dispatch: "${displayName(action)}" on "${key}" would wait behind "${holder.name}", which the restore resumed ` +
						`holding "${key}" with its wait not sent until the restore releases it: once the repair settles, or at once with no ` +
						`repair. A repair that waited on it would never settle. Dispatch it after restoreRuntime resolves.`,
					holder
				);
			}
			return sameFunction("dispatch", action, key);
		},
		refuseStart: (action, key) => sameFunction("start", action, key)
	};
}

function malformedDetail(drop: IResumeDrop, malformed: ReadonlySet<string>, unreadable: boolean): string | undefined {
	if (drop.reason !== "no-history") {
		return drop.detail;
	}
	if (unreadable) {
		return "the snapshot's Histories section is malformed, so it is read as none";
	}
	return malformed.has(drop.actionId) ? "its history in the snapshot is malformed, so it is read as none" : drop.detail;
}

function report<T extends object>(runtime: IRuntimeInternal<T>, dropped: readonly IResumeDrop[]): void {
	if (!DEV) {
		return;
	}
	const watched = dropped.filter((drop) => drop.reason === "watched");
	if (watched.length > 0) {
		runtime.emitDiag({
			severity: "warn",
			code: "resume/tree-watched",
			message:
				`[treflex] restore: ${watched.length} action(s) that could have resumed were dropped, because a reactive scope had read ` +
				`the tree before the restore's replays ran (${watched[0]!.detail}). Create effects and memos over the tree after ` +
				"restoreRuntime resolves, not in setup.",
			data: {
				count: watched.length,
				actionIds: watched.map((drop) => drop.actionId),
				detail: watched[0]!.detail ?? null
			}
		});
	}
	const named = new Set<string>();
	for (const drop of dropped) {
		if (!drop.ownDoing || drop.name === null || named.has(drop.name)) {
			continue;
		}
		named.add(drop.name);
		runtime.emitDiag({
			severity: "warn",
			code: "resume/never-resumes",
			message:
				`[treflex] restore: "${drop.name}" is marked resumable and was dropped for what it does itself (${drop.reason}: ` +
				`${drop.detail}). A run that does this never resumes, so its repair always runs.`,
			data: {
				name: drop.name,
				actionId: drop.actionId,
				reason: drop.reason,
				detail: drop.detail ?? null
			}
		});
	}
}

/**
 * The restore's stage between the unresolved receivers and the repair, on a runtime with `resume`:
 * every in-flight row is resumed or dropped, synchronously, and until `release` the public dispatch
 * refuses what would meet a resumed action's held wait or run a resumed function again on its
 * entity, and a `start` refuses the second.
 */
export function resumeAtRestore<T extends object>(
	runtime: IRuntimeInternal<T>,
	snapshot: ISnapshot,
	listed: readonly IInFlightListing[],
	sameBuild: boolean,
	loaded: ReadonlyMap<string, string>
): IResumeStage {
	const read = sameBuild
		? historiesOf(snapshot)
		: {
				histories: [],
				malformed: new Set<string>(),
				unreadable: false
			};
	const support = runtime.get("runtime/prefixes");
	const outcome = resumeInFlight(runtime, {
		rows: snapshot.InFlight,
		histories: read.histories,
		sameBuild,
		isIdempotent,
		loaded
	});
	if (outcome.resumed.length > 0) {
		support?.window(windowOver(outcome.resumed));
	}
	const drops = new Map(
		outcome.dropped.map((drop) => [
			drop.actionId,
			drop
		])
	);
	const order = new Map(
		listed.map((row, at) => [
			row.actionId,
			at
		])
	);
	const dropped: IRestoreDrop[] = [];
	for (const row of listed) {
		const drop = drops.get(row.actionId);
		if (drop === undefined) {
			continue;
		}
		const detail = malformedDetail(drop, read.malformed, read.unreadable);
		dropped.push({
			...row,
			reason: drop.reason,
			...(detail === undefined
				? {}
				: {
						detail
					}),
			...(drop.wait === undefined
				? {}
				: {
						wait: drop.wait
					})
		});
	}
	const resumed = [
		...outcome.resumed
	]
		.sort((a, b) => (order.get(a.actionId) ?? 0) - (order.get(b.actionId) ?? 0))
		.map(
			(entry): IRestoreResumed => ({
				actionId: entry.actionId,
				name: entry.name,
				entityId: entry.entityId,
				...(entry.wait === undefined
					? {}
					: {
							wait: entry.wait
						}),
				resourceWork: entry.resourceWork.map((work) => ({
					key: work.key,
					ownerId: work.ownerId
				}))
			})
		);
	outcome.deliver();
	report(runtime, outcome.dropped);
	let released = false;
	return {
		resumed,
		dropped,
		release() {
			if (released) {
				return;
			}
			released = true;
			support?.window(null);
			outcome.release();
		}
	};
}
