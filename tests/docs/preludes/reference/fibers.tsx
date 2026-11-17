import { entity, open, parallel, parallelSettled, publishToNearest, start, type IActionGenerator, type IEntity } from "treflex";

declare module "treflex" {
	interface IMessageRegistry {
		"Upload/Done": { UploadId: string };
	}
}

interface IUser {}
interface IPost {}
declare function loadUsers(): IActionGenerator<IUser[]>;
declare function loadPosts(): IActionGenerator<IPost[]>;
interface IFeed extends IEntity {
	Users: IUser[];
	PostsFailed: boolean;
}

interface IUpload extends IEntity {
	Name: string;
	Progress: number;
}
interface IUploads extends IEntity {
	Uploads: IUpload[];
}
declare function sendFile(name: string): IActionGenerator<number>;

interface IPart {}
interface IDocument extends IEntity {
	Preview: string;
	Parts: IPart[];
}
declare function fetchPreview(id: string): IActionGenerator<string>;
declare function fetchParts(id: string): IActionGenerator<IPart[]>;
