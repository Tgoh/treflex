// Run by scripts/react18/vitest.config.mjs. It sits beside the tests so it resolves react as they do.
import { version as react } from "react";
import { version as reactDom } from "react-dom";

const expected = import.meta.env.TREFLEX_EXPECTED_REACT;
if (react !== expected || reactDom !== expected) {
	throw new Error(`test:react18 loaded react ${react} and react-dom ${reactDom}, expected ${expected}`);
}
