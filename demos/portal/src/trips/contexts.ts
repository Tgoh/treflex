import type { ILeg } from "./Leg";
import type { IPlanner } from "./Planner";
import type { ITrip } from "./Trip";
import { createEntityFeature } from "treflex-solid";
import * as LegFeature from "./Leg";
import * as PlannerFeature from "./Planner";
import * as TripFeature from "./Trip";

export const Planner = createEntityFeature<IPlanner>("Portal/Trips/Planner")(PlannerFeature.actions, PlannerFeature.selectors);

export const Trip = createEntityFeature<ITrip>("Portal/Trips/Trip")(TripFeature.actions, TripFeature.selectors);

export const Leg = createEntityFeature<ILeg>("Portal/Trips/Leg")(LegFeature.actions, LegFeature.selectors);
