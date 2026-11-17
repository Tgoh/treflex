import type { IExternalSource } from "../Types/IExternalSource";
import { callbackThrew, consoleDiag, type IDiagEmitter } from "../Types/IRuntimeEvent";

declare module "../Registries/IRuntimeServiceRegistry" {
	interface IRuntimeServiceRegistry {
		"runtime/externalSources": IExternalSourceRegistry;
	}
}

export interface IExternalSourceRegistry {
	register(source: IExternalSource): void;
	resolveData(key: string): unknown;
	getSubscribers(topic: string): readonly IExternalSource[];
	dispose(): void;
}

export function createExternalSourceRegistry(report: IDiagEmitter = consoleDiag): IExternalSourceRegistry {
	const byId = new Map<string, IExternalSource>();
	const byDataSourceKey = new Map<string, IExternalSource>();
	const byTopic = new Map<string, Set<IExternalSource>>();

	function register(source: IExternalSource): void {
		if (byId.has(source.Id)) {
			console.warn(`[treflex] external source "${source.Id}" is already registered — the second registration is ignored.`);
			return;
		}
		byId.set(source.Id, source);

		for (const key of source.DataSourceKeys ?? []) {
			const existing = byDataSourceKey.get(key);
			if (existing) {
				console.warn(
					`[treflex] external source "${source.Id}" registers data-source key "${key}", already served by "${existing.Id}" — ` +
						`the first registration wins.`
				);
				continue;
			}
			byDataSourceKey.set(key, source);
		}

		for (const topic of source.Topics ?? []) {
			let bucket = byTopic.get(topic);
			if (!bucket) {
				bucket = new Set();
				byTopic.set(topic, bucket);
			}
			bucket.add(source);
		}
	}

	function resolveData(key: string): unknown {
		return byDataSourceKey.get(key)?.getData?.(key);
	}

	function getSubscribers(topic: string): readonly IExternalSource[] {
		const bucket = byTopic.get(topic);
		return bucket
			? [
					...bucket
				]
			: [];
	}

	function dispose(): void {
		for (const source of byId.values()) {
			try {
				source.dispose?.();
			} catch (error) {
				report(
					callbackThrew(`External source "${source.Id}"'s dispose`, error, {
						sourceId: source.Id
					})
				);
			}
		}
		byId.clear();
		byDataSourceKey.clear();
		byTopic.clear();
	}

	return {
		register,
		resolveData,
		getSubscribers,
		dispose
	};
}
