declare const ENTITY_ID: unique symbol;

export interface IEntity {
	$Id: string;
}

/**
 * An entity's address, from `idOf`, for a field that refers to a node held elsewhere. It's a
 * plain string at runtime, so it stores and crosses as data, and everything that takes an id
 * takes it. Nothing should be read into its contents.
 */
export type IEntityId = string & {
	readonly [ENTITY_ID]: true;
};
