import { defineEffect, type IEffect } from "treflex";

interface IDelay extends IEffect {
	Type: "Counter/Delay";
	Ms: number;
}

export const delay = defineEffect<IDelay, void>("Counter/Delay");
