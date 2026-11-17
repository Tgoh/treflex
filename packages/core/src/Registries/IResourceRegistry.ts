import type { IEnded } from "../Types/IResource";

// Maps resource type → what the type takes and produces. See
// docs/reference/live-sources.md#registries.
//
//   Params        the settings handed to the implementation, beside `Type`
//   Message       what the type emits
//   Value         what the type exposes to views
//   Methods       named methods, plain-data arguments and results
//   Supply        the live value a view supplies
//   SupplyResponse what a supply answers, plain data
//   ResumeFrom    "required" when the type cannot work without a cursor
//
// Omitted fields default to never, except Params, which defaults to {} so a
// type with no settings still opens with `{ Type }` alone.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface IResourceTypeRegistry {}

// Maps resource key → { Type, Message?, Params? }. A key's `Message`
// overrides its type's (`never` opens it without a receiver), and its
// `Params` are intersected with the type's.
//
// biome-ignore lint/suspicious/noEmptyInterface: declaration-merge target
export interface IResourceRegistry {}

export type IResourceTypeName = keyof IResourceTypeRegistry & string;
export type IResourceKey = keyof IResourceRegistry & string;

type IFieldOf<E, F extends PropertyKey, D> = E extends {
	[P in F]: infer V;
}
	? V
	: D;

type IIsNever<T> = [
	T
] extends [
	never
]
	? true
	: false;

export type IResourceTypeOf<K extends IResourceKey> = IResourceRegistry[K] extends {
	Type: infer T extends IResourceTypeName;
}
	? T
	: never;

type ITypeEntry<T extends IResourceTypeName> = IResourceTypeRegistry[T];

export type IResourceTypeParamsOf<T extends IResourceTypeName> = {
	Type: T;
} & IFieldOf<ITypeEntry<T>, "Params", {}>;
export type IResourceTypeMessageOf<T extends IResourceTypeName> = IFieldOf<ITypeEntry<T>, "Message", never>;
export type IResourceTypeValueOf<T extends IResourceTypeName> = IFieldOf<ITypeEntry<T>, "Value", never>;
export type IResourceTypeMethodsOf<T extends IResourceTypeName> = IFieldOf<ITypeEntry<T>, "Methods", never>;
export type IResourceTypeSupplyOf<T extends IResourceTypeName> = IFieldOf<ITypeEntry<T>, "Supply", never>;
export type IResourceTypeSupplyResponseOf<T extends IResourceTypeName> = IFieldOf<ITypeEntry<T>, "SupplyResponse", never>;

export type IResourceMessageOf<K extends IResourceKey> = IFieldOf<
	IResourceRegistry[K],
	"Message",
	IResourceTypeMessageOf<IResourceTypeOf<K>>
>;
export type IResourceParamsOf<K extends IResourceKey> = IResourceTypeParamsOf<IResourceTypeOf<K>> &
	IFieldOf<IResourceRegistry[K], "Params", {}>;
export type IResourceValueOf<K extends IResourceKey> = IResourceTypeValueOf<IResourceTypeOf<K>>;
export type IResourceMethodsOf<K extends IResourceKey> = IResourceTypeMethodsOf<IResourceTypeOf<K>>;
export type IResourceSupplyOf<K extends IResourceKey> = IResourceTypeSupplyOf<IResourceTypeOf<K>>;
export type IResourceSupplyResponseOf<K extends IResourceKey> = IResourceTypeSupplyResponseOf<IResourceTypeOf<K>>;

export type IResourceRequiresResume<K extends IResourceKey> =
	IIsNever<IFieldOf<ITypeEntry<IResourceTypeOf<K>>, "ResumeFrom", never>> extends true
		? false
		: [
					IFieldOf<ITypeEntry<IResourceTypeOf<K>>, "ResumeFrom", never>
				] extends [
					"required"
				]
			? true
			: false;

// Distributes, so a union message is checked member by member.
type IMessageShapeHolds<M> = M extends readonly unknown[]
	? false
	: M extends (...args: any[]) => any
		? false
		: M extends object
			? "Type" extends keyof M
				? false
				: IIsNever<Extract<keyof M, `$${string}`>>
			: false;

// Only `Message` is spread into a receiver's argument, so it must be a
// plain non-array object with no `Type` and no `$`-prefixed field. unknown
// and never are exempt.
export type IResourceMessageRuleHolds<M> =
	IIsNever<M> extends true ? true : unknown extends M ? true : false extends IMessageShapeHolds<M> ? false : true;

// A key whose resolved Message is never takes no receiver, unless its TYPE
// never emits either: then a receiver may still be passed to hear $Ended.
export type IResourceKeyEmits<K extends IResourceKey> = IIsNever<IResourceMessageOf<K>> extends true ? false : true;
export type IResourceTypeEmits<K extends IResourceKey> = IIsNever<IResourceTypeMessageOf<IResourceTypeOf<K>>> extends true ? false : true;

export type IReceivableResourceKey = {
	[K in IResourceKey]: IResourceKeyEmits<K> extends true ? K : IResourceTypeEmits<K> extends true ? never : K;
}[IResourceKey];

export type IResourceEndedOf<K extends string> = {
	Type: K;
	$Ended: IEnded;
};

export type IResourceDeliveryOf<K extends IResourceKey> =
	IResourceKeyEmits<K> extends true
		?
				| ({
						Type: K;
				  } & IResourceMessageOf<K>)
				| IResourceEndedOf<K>
		: IResourceEndedOf<K>;
