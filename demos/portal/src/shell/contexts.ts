import type { IPortal } from "../portal/Portal";
import type { ITour } from "../tour/Tour";
import { createEntityFeature } from "treflex-solid";
import * as PortalFeature from "../portal/Portal";
import * as TourFeature from "../tour/Tour";

export const Portal = createEntityFeature<IPortal>("Portal/Portal")(PortalFeature.actions, PortalFeature.selectors);

export const Tour = createEntityFeature<ITour>("Portal/Tour")(TourFeature.actions, TourFeature.selectors);
