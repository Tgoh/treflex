import type { IBuild } from "../../portal/src/shell/builds";
import type { IRendererModule } from "./swap";

// A glob rather than import(): tsc doesn't follow it, so neither tsconfig reads the other renderer's JSX.
const modules = import.meta.glob<IRendererModule>([
	"./solid/mount.tsx",
	"./react/mount.tsx"
]);

export const RENDERERS: Record<IBuild, () => Promise<IRendererModule>> = {
	solid: modules["./solid/mount.tsx"],
	react: modules["./react/mount.tsx"]
};
