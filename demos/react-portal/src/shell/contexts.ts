import type { IPortal } from "../../../portal/src/portal/Portal";
import type { ITour } from "../../../portal/src/tour/Tour";
import { createEntityFeature } from "treflex-react";
import * as PortalFeature from "../../../portal/src/portal/Portal";
import * as TourFeature from "../../../portal/src/tour/Tour";

export const Portal = createEntityFeature<IPortal>("Portal/Portal")(PortalFeature.actions, PortalFeature.selectors);

export const Tour = createEntityFeature<ITour>("Portal/Tour")(TourFeature.actions, TourFeature.selectors);
