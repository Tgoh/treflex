import type { IAskId, IRuntime } from "treflex";
import type { IAddress } from "../server/effects";
import type { IFakeServer } from "../server/fakeServer";
import type { ICheckoutRequest, IShop } from "../shop/shop";
import type { IGates } from "./gates";
import { createTestRuntime, guids } from "treflex";
import { createFakeServer, serverImplementations } from "../server/fakeServer";
import { currentAsk, getDefaultState } from "../shop/shop";
import { createGates } from "./gates";

export const ADA: IAddress = {
	Name: "Ada",
	Street: "1 Loop Road",
	Postcode: "3000"
};

export interface IBootedShop {
	runtime: IRuntime<IShop>;
	server: IFakeServer;
	gates: IGates;
}

/** A shop on a fresh fake server, whose `gated` request types wait for the test to release them. */
export function bootShop(gated: readonly string[] = [], server: IFakeServer = createFakeServer()): IBootedShop {
	const gates = createGates(gated);
	const runtime = createTestRuntime<IShop>(getDefaultState(), {
		...serverImplementations(server, gates.wait),
		generateGuid: guids("key")
	});
	return {
		runtime,
		server,
		gates
	};
}

export const openAsk = (runtime: IRuntime<IShop>) => runtime.processSelector(currentAsk, () => runtime.state.Order);

export function askAt<R>(runtime: IRuntime<IShop>, path: ICheckoutRequest["Path"]): IAskId<R> {
	const entry = openAsk(runtime);
	if (entry?.Request.Path !== path) throw new Error(`no ${path} question is open; open: ${entry?.Request.Path ?? "none"}`);
	return entry.Id as IAskId<R>;
}
