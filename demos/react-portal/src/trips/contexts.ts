import type { ILeg } from "../../../portal/src/trips/Leg";
import type { IPlanner } from "../../../portal/src/trips/Planner";
import type { ITrip } from "../../../portal/src/trips/Trip";
import { createEntityFeature } from "treflex-react";
import * as LegFeature from "../../../portal/src/trips/Leg";
import * as PlannerFeature from "../../../portal/src/trips/Planner";
import * as TripFeature from "../../../portal/src/trips/Trip";

export const Planner = createEntityFeature<IPlanner>("Portal/Trips/Planner")(PlannerFeature.actions, PlannerFeature.selectors);

export const Trip = createEntityFeature<ITrip>("Portal/Trips/Trip")(TripFeature.actions, TripFeature.selectors);

export const Leg = createEntityFeature<ILeg>("Portal/Trips/Leg")(LegFeature.actions, LegFeature.selectors);
