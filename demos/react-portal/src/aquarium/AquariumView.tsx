import type { RefObject } from "react";
import type { IEntityView } from "treflex-react";
import type { ISchool } from "../../../portal/src/aquarium/Aquarium";
import type { IFish } from "../../../portal/src/aquarium/Fish";
import type { IRestoreProps } from "../shell/RestoreBanner";
import { useLayoutEffect, useRef, useState } from "react";
import { useEntity } from "treflex-react";
import {
	BUBBLES,
	GIANT_COLOUR,
	loopDelay,
	PHOTOPHORE_S,
	PHOTOPHORE_STAGGER_S,
	SNOW,
	schoolColour
} from "../../../portal/src/aquarium/decoration";
import { swimInProgress } from "../../../portal/src/aquarium/Fish";
import { wallClock } from "../../../portal/src/portal/clock";
import { cx, styled } from "../shell/dom";
import { RestoreBanner } from "../shell/RestoreBanner";
import { Aquarium } from "./contexts";

const PHOTOPHORE_X = [
	45,
	57,
	69
];
const PHOTOPHORE_Y = [
	39,
	41,
	40
];

function FishView(props: { fish: IEntityView<IFish> }) {
	const fish = props.fish;
	const [delays] = useState(() => ({
		undulate: loopDelay(fish.Wobble),
		tail: loopDelay(fish.Wobble * 0.5),
		photophores: PHOTOPHORE_X.map((_, index) => loopDelay(PHOTOPHORE_S, index * PHOTOPHORE_STAGGER_S))
	}));
	return (
		<div
			className="fish-body"
			style={{
				...styled({
					"--hue": `${fish.Hue}`,
					"--wobble": `${fish.Wobble}s`,
					"--undulate-delay": `${delays.undulate}s`,
					"--tail-delay": `${delays.tail}s`,
					"--glow": `${fish.Glow}px`
				}),
				width: `${fish.Length}px`,
				transform: `scaleX(${fish.Facing})`
			}}
		>
			<svg className="fish-svg" viewBox="0 0 104 56" aria-hidden="true">
				<path className="fish-tail" d="M 24 28 L 3 11 L 13 28 L 3 45 Z" />
				<path className="fish-fin" d="M 49 11 Q 61 -1 73 13 Z" />
				<path className="fish-fin" d="M 51 45 Q 58 54 67 44 Z" />
				<path className="fish-core" d="M 24 28 C 37 8 75 8 93 28 C 75 48 37 48 24 28 Z" />
				{PHOTOPHORE_X.map((x, index) => (
					<circle
						key={x}
						className="photophore"
						cx={x}
						cy={PHOTOPHORE_Y[index]}
						r="2.4"
						style={{
							animationDelay: `${delays.photophores[index]}s`
						}}
					/>
				))}
				<circle className="fish-eye" cx="84" cy="24" r="3.4" />
				<circle className="fish-glint" cx="85.4" cy="22.6" r="1.1" />
			</svg>
		</div>
	);
}

function Swimmer(props: { fish: IEntityView<IFish>; title: string; mounted: RefObject<boolean>; onRelease: () => void }) {
	const fish = props.fish;
	const [start] = useState(() => ({
		arriving: props.mounted.current,
		swim: swimInProgress(fish, wallClock()),
		swimTo: [
			fish.X,
			fish.Y
		]
	}));
	const swim = start.swim;
	const [holding, setHolding] = useState(swim !== null);
	const [delay, setDelay] = useState(0);
	const slot = useRef<HTMLDivElement>(null);
	// Not useEffect: an update from a layout effect renders before the browser paints, so the slot is never painted
	// at the swim's start. The start has to be in computed style before the move to X and Y, or the move starts no
	// transition.
	useLayoutEffect(() => {
		if (!start.swim || !slot.current) return;
		void getComputedStyle(slot.current).transform;
		setDelay(start.swim.Elapsed);
		setHolding(false);
	}, [
		start
	]);
	const resuming = delay > 0 && fish.X === start.swimTo[0] && fish.Y === start.swimTo[1];
	return (
		<div
			ref={slot}
			className={cx("fish-slot", {
				arriving: start.arriving,
				holding
			})}
			style={{
				...styled({
					"--fish-x": `${holding && swim ? swim.FromX : fish.X}`,
					"--fish-y": `${holding && swim ? swim.FromY : fish.Y}`
				}),
				transitionDelay: resuming ? `${-delay}ms` : undefined
			}}
		>
			<button type="button" className="fish-inner" onClick={() => props.onRelease()} title={props.title}>
				<FishView fish={fish} />
			</button>
		</div>
	);
}

function FishSlot(props: { id: string; title: string; mounted: RefObject<boolean>; onRelease: () => void }) {
	const fish = useEntity<IFish>(props.id);
	return fish ? <Swimmer fish={fish} title={props.title} mounted={props.mounted} onRelease={props.onRelease} /> : null;
}

function SchoolLayer(props: { id: string; mounted: RefObject<boolean>; onRelease: (schoolId: string, fishId: string) => void }) {
	const school = useEntity<ISchool>(props.id);
	if (!school) return null;
	return (
		<div className="school-layer">
			{school.Fish.map((fish) => (
				<FishSlot
					key={fish.$Id}
					id={fish.$Id}
					title="Release this fish"
					mounted={props.mounted}
					onRelease={() => props.onRelease(school.$Id, fish.$Id)}
				/>
			))}
		</div>
	);
}

function SchoolChip(props: { id: string; canAddFish: boolean; onAdd: () => void; onRelease: () => void }) {
	const school = useEntity<ISchool>(props.id);
	if (!school) return null;
	return (
		<span className="school">
			<i
				style={{
					background: schoolColour(school.Hue)
				}}
			/>
			{school.Name} · {school.Fish.length}
			<button type="button" disabled={!props.canAddFish} onClick={() => props.onAdd()} title="Add a fish to this school">
				+
			</button>
			<button type="button" onClick={() => props.onRelease()} title="Release this school, and every fish in it with it">
				×
			</button>
		</span>
	);
}

export const AquariumView = Aquarium.provider<{
	restore: IRestoreProps;
}>((props) => {
	const aquarium = Aquarium.use();
	const facts = aquarium.tankFacts();
	const swimLine = aquarium.swimLine();
	const mounted = useRef(false);
	useLayoutEffect(() => {
		mounted.current = true;
	}, []);
	const [snow] = useState(() => SNOW.map((p) => loopDelay(p.dur, p.delay)));
	const [bubbles] = useState(() => BUBBLES.map((b) => loopDelay(b.dur, b.delay)));

	return (
		<>
			<div className="top">
				<div className="crumbs">
					<b>Aquarium</b>
				</div>
				<div className="btns">
					<button type="button" className="btn" disabled={!facts.CanAddGiant} onClick={() => aquarium.addGiant()}>
						Release a giant
					</button>
					<button type="button" className="btn dark" disabled={!facts.CanAddSchool} onClick={() => aquarium.addSchool()}>
						+ Add a school
					</button>
				</div>
			</div>
			{props.restore.lines ? (
				<div className="app-banner">
					<RestoreBanner restore={props.restore} />
				</div>
			) : null}
			<div className="tank">
				<div className="rays" />
				<div className="floor" />
				{SNOW.map((p, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: SNOW is fixed
						key={index}
						className="snow"
						style={{
							...styled({
								"--dur": `${p.dur}s`,
								"--delay": `${snow[index]}s`,
								"--drift": `${p.drift}px`
							}),
							left: `${p.x}%`,
							width: `${p.size}px`,
							height: `${p.size}px`
						}}
					/>
				))}
				{BUBBLES.map((b, index) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: BUBBLES is fixed
						key={index}
						className="bubble"
						style={{
							...styled({
								"--dur": `${b.dur}s`,
								"--delay": `${bubbles[index]}s`
							}),
							left: `${b.x}%`,
							width: `${b.size}px`,
							height: `${b.size}px`
						}}
					/>
				))}
				{aquarium.state.Schools.map((school) => (
					<SchoolLayer
						key={school.$Id}
						id={school.$Id}
						mounted={mounted}
						onRelease={(schoolId, fishId) => aquarium.releaseFish(schoolId, fishId)}
					/>
				))}
				<div className="giant-layer">
					{aquarium.state.Giants.map((giant) => (
						<FishSlot
							key={giant.$Id}
							id={giant.$Id}
							title="Release this giant"
							mounted={mounted}
							onRelease={() => aquarium.releaseGiant(giant.$Id)}
						/>
					))}
				</div>
				<div className="tankbar">
					<span>{facts.Bar}</span>
					<span>{swimLine}</span>
				</div>
				<div className="schools">
					{aquarium.state.Schools.map((school) => (
						<SchoolChip
							key={school.$Id}
							id={school.$Id}
							canAddFish={facts.CanAddFish}
							onAdd={() => aquarium.addFish(school.$Id)}
							onRelease={() => aquarium.releaseSchool(school.$Id)}
						/>
					))}
					{facts.Giants ? (
						<span className="school">
							<i
								style={{
									background: GIANT_COLOUR
								}}
							/>
							{facts.Giants}
						</span>
					) : null}
				</div>
			</div>
		</>
	);
});

export const AquariumStatus = Aquarium.provider(() => {
	const aquarium = Aquarium.use();
	return <small>{aquarium.tankFacts().Line}</small>;
});

export const AquariumDot = Aquarium.provider(() => {
	const aquarium = Aquarium.use();
	return aquarium.tankFacts().Fish > 0 ? <span className="dot" /> : null;
});
