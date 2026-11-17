import { v4 as uuidv4 } from "uuid";
import { implementation } from "../Effects/defineEffect";
import { generateGuid } from "../Effects/generateGuid";

export const implement = implementation(generateGuid, () => uuidv4());
