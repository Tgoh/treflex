import type { IAquarium } from "../../../portal/src/aquarium/Aquarium";
import { createEntityFeature } from "treflex-react";
import * as AquariumFeature from "../../../portal/src/aquarium/Aquarium";

export const Aquarium = createEntityFeature<IAquarium>("Portal/Aquarium/Aquarium")(AquariumFeature.actions, AquariumFeature.selectors);
