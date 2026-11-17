import type { IAquarium } from "./Aquarium";
import { createEntityFeature } from "treflex-solid";
import * as AquariumFeature from "./Aquarium";

export const Aquarium = createEntityFeature<IAquarium>("Portal/Aquarium/Aquarium")(AquariumFeature.actions, AquariumFeature.selectors);
