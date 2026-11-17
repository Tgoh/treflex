import type { IDestinationKey } from "../../../portal/src/trips/destinations";

export const Patterns = () => (
	<svg
		width="0"
		height="0"
		style={{
			position: "absolute"
		}}
		aria-hidden="true"
	>
		<defs>
			<pattern id="hero-lisbon" width="56" height="56" patternUnits="userSpaceOnUse">
				<rect width="56" height="56" fill="#f4f1ea" />
				<g fill="none" stroke="#2a5fa8" strokeWidth="2" opacity="0.55">
					<circle cx="28" cy="28" r="12" />
					<path d="M28 4 L36 16 L28 28 L20 16 Z M28 52 L36 40 L28 28 L20 40 Z M4 28 L16 20 L28 28 L16 36 Z M52 28 L40 20 L28 28 L40 36 Z" />
					<circle cx="0" cy="0" r="8" />
					<circle cx="56" cy="0" r="8" />
					<circle cx="0" cy="56" r="8" />
					<circle cx="56" cy="56" r="8" />
				</g>
				<circle cx="28" cy="28" r="3" fill="#2a5fa8" opacity="0.5" />
			</pattern>
			<pattern id="hero-kyoto" width="48" height="24" patternUnits="userSpaceOnUse">
				<rect width="48" height="24" fill="#f4f1ea" />
				<g fill="none" stroke="#a3333d" strokeWidth="1.6" opacity="0.5">
					<path d="M0 24 A24 24 0 0 1 48 24 M6 24 A18 18 0 0 1 42 24 M12 24 A12 12 0 0 1 36 24 M18 24 A6 6 0 0 1 30 24" />
					<path d="M-24 12 A24 24 0 0 1 24 12 M24 12 A24 24 0 0 1 72 12" />
				</g>
			</pattern>
			<pattern id="hero-reykjavik" width="52" height="45" patternUnits="userSpaceOnUse">
				<rect width="52" height="45" fill="#f4f1ea" />
				<g fill="none" stroke="#13284d" strokeWidth="1.8" opacity="0.45">
					<path d="M13 0 L39 0 L52 22.5 L39 45 L13 45 L0 22.5 Z" />
					<circle cx="26" cy="22.5" r="3" />
				</g>
			</pattern>
			<pattern id="art-lisbon" width="44" height="44" patternUnits="userSpaceOnUse">
				<rect width="44" height="44" fill="#e9eef7" />
				<g fill="none" stroke="#24519a" strokeWidth="2.2">
					<circle cx="22" cy="22" r="9" />
					<path d="M22 2 L29 13 L22 22 L15 13 Z M22 42 L29 31 L22 22 L15 31 Z M2 22 L13 15 L22 22 L13 29 Z M42 22 L31 15 L22 22 L31 29 Z" />
					<circle cx="0" cy="0" r="6" />
					<circle cx="44" cy="0" r="6" />
					<circle cx="0" cy="44" r="6" />
					<circle cx="44" cy="44" r="6" />
				</g>
				<circle cx="22" cy="22" r="3" fill="#24519a" />
			</pattern>
			<linearGradient id="art-aurora" x1="0" x2="0" y1="0" y2="1">
				<stop offset="0" stopColor="#7cf5c4" stopOpacity="0" />
				<stop offset=".5" stopColor="#5eead4" stopOpacity=".7" />
				<stop offset="1" stopColor="#a78bfa" stopOpacity="0" />
			</linearGradient>
		</defs>
	</svg>
);

export function DestinationArt(props: { destination: IDestinationKey }) {
	switch (props.destination) {
		case "lisbon":
			return (
				<svg width="100%" height="100%" aria-hidden="true">
					<rect width="100%" height="100%" fill="url(#art-lisbon)" />
				</svg>
			);
		case "kyoto":
			return (
				<svg
					viewBox="0 0 400 220"
					width="100%"
					height="100%"
					preserveAspectRatio="xMidYMax slice"
					style={{
						background: "linear-gradient(180deg,#f6c7a6 0%,#f29b7a 45%,#c75a5a 100%)"
					}}
					aria-hidden="true"
				>
					<circle cx="270" cy="96" r="44" fill="#fbe3c4" opacity=".85" />
					<path d="M0 170 Q100 140 200 162 T400 150 V220 H0Z" fill="#9c3f4a" opacity=".55" />
					<g fill="#8f1d22">
						<rect x="120" y="70" width="170" height="14" rx="3" />
						<rect x="132" y="92" width="146" height="9" />
						<rect x="146" y="84" width="13" height="136" />
						<rect x="251" y="84" width="13" height="136" />
					</g>
					<path d="M0 200 Q120 180 220 196 T400 190 V220 H0Z" fill="#5e1f2a" />
				</svg>
			);
		case "reykjavik":
			return (
				<svg
					viewBox="0 0 400 220"
					width="100%"
					height="100%"
					preserveAspectRatio="xMidYMax slice"
					style={{
						background: "linear-gradient(180deg,#0b1631 0%,#13284d 60%,#1d3557 100%)"
					}}
					aria-hidden="true"
				>
					<path
						d="M-20 120 C60 40 120 110 190 60 S320 20 420 70 L420 130 C320 80 260 140 190 110 S60 110 -20 160Z"
						fill="url(#art-aurora)"
					/>
					<g fill="#fff" opacity=".7">
						<circle cx="40" cy="30" r="1.2" />
						<circle cx="110" cy="22" r="1" />
						<circle cx="330" cy="40" r="1.3" />
						<circle cx="250" cy="18" r="1" />
						<circle cx="360" cy="110" r="1" />
						<circle cx="70" cy="80" r=".9" />
					</g>
					<path d="M0 180 L70 140 L120 168 L190 120 L260 166 L320 138 L400 172 V220 H0Z" fill="#0a1226" />
				</svg>
			);
		default:
			return props.destination satisfies never;
	}
}
