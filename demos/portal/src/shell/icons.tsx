import type { JSX } from "solid-js";
import type { IAppIcon } from "../portal/apps";
import { Dynamic } from "solid-js/web";

export const PlaneIcon = () => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M2 16l20-8-9 13-2-6-9 1z" />
	</svg>
);

export const FishIcon = () => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M3 12c3-5 9-6 14-2l4-3v10l-4-3c-5 4-11 3-14-2z" />
	</svg>
);

export const ChatIcon = () => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M4 5h16v11H9l-5 4z" />
	</svg>
);

const APP_ICONS: Record<IAppIcon, () => JSX.Element> = {
	plane: PlaneIcon,
	fish: FishIcon,
	chat: ChatIcon
};

export function AppIcon(props: { icon: IAppIcon }) {
	return <Dynamic component={APP_ICONS[props.icon]} />;
}

export const HotelIcon = () => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M3 21V8l9-5 9 5v13" />
		<path d="M9 21v-6h6v6" />
	</svg>
);

export const CompassIcon = () => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<circle cx="12" cy="12" r="9" />
		<path d="M15.5 8.5l-2 5-5 2 2-5z" />
	</svg>
);

export const RestoreIcon = () => (
	<svg viewBox="0 0 24 24" aria-hidden="true">
		<path d="M3 12a9 9 0 1 0 3-6.7" />
		<path d="M3 4v5h5" />
	</svg>
);

export const CheckIcon = () => (
	<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
		<path d="M20 6L9 17l-5-5" />
	</svg>
);
