import type { IEffect } from "../Types/IEffect";
import { defineEffect } from "./defineEffect";

export const generateGuid = defineEffect<
	IEffect & {
		Type: "generateGuid";
	},
	string
>("generateGuid", {
	settles: "sync"
});
