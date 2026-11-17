import { installMedia } from "./testMedia";

// oneCopy.test.ts runs in node, with no window.
if (typeof window !== "undefined") installMedia();
