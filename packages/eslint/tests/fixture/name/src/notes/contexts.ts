import type { INote } from "./notes";
import { createEntityFeature } from "../feature";
import * as NotesFeature from "./notes";

export const Note = createEntityFeature<INote>("App/Notebook/Note")(NotesFeature.actions);
